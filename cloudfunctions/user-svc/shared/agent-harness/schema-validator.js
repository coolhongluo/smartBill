/**
 * 结构化输出校验器 —— 技术文档 §3.6
 *
 * 记账是强约束场景：一次金额识别错 10 倍就会污染账本，
 * 而错误的纠正成本远高于一次点击。因此模型输出必须经过严格校验，
 * 校验失败先修复重试，仍失败走规则兜底，绝不放行。
 */

const errors = [];

/**
 * 校验是否合法 JSON
 */
function validateJSON(raw) {
  if (typeof raw !== 'string') return { ok: false, error: '返回类型不是字符串' };
  let text = raw.trim();
  // 模型有时会包markdown 代码块
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  // 去掉 JSON 前后的散文（模型偶尔会加解释）
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return { ok: false, error: '找不到 JSON 对象边界' };
  if (start > 0 || end < text.length - 1) text = text.slice(start, end + 1);

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: `JSON 解析失败: ${e.message}` };
  }
}

/**
 * 按 JSON Schema 做类型/必填/枚举/范围校验（子集实现，覆盖记账场景所需）
 */
function validateSchema(data, schema) {
  const errs = [];

  if (schema.required) {
    for (const key of schema.required) {
      if (data[key] === undefined || data[key] === null) {
        errs.push(`缺少必填字段 ${key}`);
      }
    }
  }

  for (const [key, spec] of Object.entries(schema.properties || {})) {
    const val = data[key];
    if (val === undefined || val === null) continue;

    if (spec.type === 'number') {
      if (typeof val !== 'number' || isNaN(val)) {
        errs.push(`${key} 应为数字，实际为 ${typeof val}`);
        continue;
      }
      if (spec.minimum !== undefined && val < spec.minimum) errs.push(`${key} 应 ≥ ${spec.minimum}，实际 ${val}`);
      if (spec.maximum !== undefined && val > spec.maximum) errs.push(`${key} 应 ≤ ${spec.maximum}，实际 ${val}`);
    }

    if (spec.type === 'string' && spec.enum && !spec.enum.includes(val)) {
      errs.push(`${key} 应为 [${spec.enum.join('|')}] 之一，实际为 ${val}`);
    }

    if (spec.type === 'integer' && !Number.isInteger(val)) {
      errs.push(`${key} 应为整数，实际 ${val}`);
    }

    if (spec.type === 'boolean' && typeof val !== 'boolean') {
      errs.push(`${key} 应为布尔值，实际 ${typeof val}`);
    }

    if (spec.type === 'array') {
      if (!Array.isArray(val)) {
        errs.push(`${key} 应为数组`);
        continue;
      }
      if (spec.minItems !== undefined && val.length < spec.minItems) {
        errs.push(`${key} 至少 ${spec.minItems} 项，实际 ${val.length} 项`);
      }
      if (spec.maxItems !== undefined && val.length > spec.maxItems) {
        errs.push(`${key} 最多 ${spec.maxItems} 项，实际 ${val.length} 项`);
      }
      if (spec.items) {
        for (const item of val) {
          if (spec.items.type === 'object' && spec.items.required) {
            for (const rk of spec.items.required) {
              if (item[rk] === undefined || item[rk] === null) {
                errs.push(`${key} 中的元素缺少字段 ${rk}`);
              }
            }
          }
        }
      }
    }
  }

  return { ok: errs.length === 0, errors: errs };
}

/**
 * 业务校验：类目 ID 必须真实存在 —— 防幻觉的核心（技术文档 §3.6.2）
 * @returns {{ok:boolean, hasHallucination:boolean, validIds:string[], invalidIds:string[]}}
 */
function validateCategories(data, validCategoryIds, pathKey = 'categoryCandidates') {
  const list = data[pathKey];
  if (!Array.isArray(list)) return { ok: true, hasHallucination: false, validIds: [], invalidIds: [] };

  const validIds = [];
  const invalidIds = [];
  const validSet = new Set(validCategoryIds);

  for (const item of list) {
    const id = item && item.categoryId;
    if (!id) continue;
    if (validSet.has(id)) validIds.push(id);
    else invalidIds.push(id);
  }

  return {
    ok: invalidIds.length === 0,
    hasHallucination: invalidIds.length > 0,
    validIds,
    invalidIds
  };
}

/**
 * 完整校验流程
 */
function validate(rawOutput, schema, validCategoryIds, categoryPathKey) {
  // 步骤 1：JSON 合法性
  const jsonRes = validateJSON(rawOutput);
  if (!jsonRes.ok) {
    return { ok: false, stage: 'json', error: jsonRes.error, data: null };
  }
  const data = jsonRes.value;

  // 步骤 2：Schema 校验
  if (schema) {
    const schemaRes = validateSchema(data, schema);
    if (!schemaRes.ok) {
      return { ok: false, stage: 'schema', errors: schemaRes.errors, error: schemaRes.errors.join('; '), data };
    }
  }

  // 步骤 3：业务校验（防幻觉）
  if (validCategoryIds && categoryPathKey) {
    const catRes = validateCategories(data, validCategoryIds, categoryPathKey);
    if (!catRes.ok) {
      return {
        ok: false,
        stage: 'business',
        error: `模型给出了不存在的类目: ${catRes.invalidIds.join(', ')}`,
        hasHallucination: true,
        data
      };
    }
  }

  return { ok: true, data };
}

/**
 * 生成修复重试的追加提示
 * @param {object} lastError 上次校验失败信息
 */
function buildRepairHint(lastError, context = {}) {
  const base = '你上一次的输出未通过校验，请重新输出。';
  if (!lastError) return base;
  if (lastError.stage === 'json') {
    return `${base}\n问题：返回的不是合法 JSON。请只输出一个 JSON 对象，不要添加任何解释文字或 markdown 代码块标记。`;
  }
  if (lastError.stage === 'schema') {
    return `${base}\n问题：${lastError.errors.join('；')}。请严格按照字段要求修正，特别是类型、必填项和枚举取值。`;
  }
  if (lastError.stage === 'business') {
    // 幻觉修复必须附上合法清单，否则等于让模型再猜一次
    // （实测：只说"不可编造"而不给清单，重试后仍编造同一个 ID）
    const { validCategoryIds, input } = context;
    let hint = `${base}\n问题：${lastError.error}。你必须从下方清单中选择，不可自行编造或推导 ID。`;

    if (Array.isArray(validCategoryIds) && validCategoryIds.length) {
      const { CATEGORY_MAP } = require('../util/category-preset');
      // 按输入文本里的关键词排序，把最相关的放前面，减少模型选错概率
      const scored = validCategoryIds
        .map((id) => {
          const meta = CATEGORY_MAP.get(id);
          if (!meta) return null;
          let s = 0;
          const text = String(input || '');
          for (const kw of meta.keywords || []) if (text.includes(kw)) s += 2;
          for (const al of meta.aliases || []) if (text.includes(al)) s += 2;
          if (text.includes(meta.name)) s += 3;
          return { id, name: meta.name, path: meta.path, s };
        })
        .filter(Boolean)
        .sort((a, b) => b.s - a.s);

      const relevant = scored.filter((x) => x.s > 0).slice(0, 12);
      const list = relevant.length ? relevant : scored.slice(0, 20);
      hint += `\n\n【合法类目 ID 清单】\n${list.map((x) => `${x.id} ${x.path}`).join('\n')}`;
      if (relevant.length) {
        hint += `\n\n请优先从上述前 ${relevant.length} 项中选择。`;
      }
    }
    return hint;
  }
  return base;
}

module.exports = {
  validate,
  validateJSON,
  validateSchema,
  validateCategories,
  buildRepairHint
};