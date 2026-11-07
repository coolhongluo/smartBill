/**
 * 测试用的 HTTP mock
 *
 * ## 为什么不用 mock global.fetch
 *
 * 云端实际走的是 `shared/util/http-client`（基于 https 模块），
 * 因为 Nodejs18.15 + CommonJS 下没有全局 fetch。
 * 所以 mock 也要注入到 http-client 的注入点上，
 * 否则测的还是「本地 Node 22 有 fetch」那条假路径。
 *
 * **这是本项目最隐蔽的一类问题**：
 * 测试全绿 ≠ 云端能跑。mock 的东西必须与生产走同一条路。
 */

/**
 * 安装 mock 的 HTTP 实现
 *
 * @param {function} handler (url, options) => {ok, status, json|text}
 * @returns {function} 恢复函数
 */
function mockHttp(handler) {
  // 延迟 require，避免测试文件加载顺序问题
  const httpClient = require('../../../util/http-client');
  httpClient.__setImpl(handler);
  return () => httpClient.__setImpl(null);
}

/**
 * 按脚本依次返回预设响应
 *
 * @param {Array} responses 响应对象数组
 * @returns {{count: function(): number}} 已调用次数
 */
function mockResponses(responses) {
  let i = 0;
  mockHttp(async () => {
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body)
    };
  });
  return { count: () => i };
}

/**
 * 模拟网络异常
 */
function mockNetworkError(message = 'network down') {
  mockHttp(async () => {
    throw new Error(message);
  });
}

module.exports = { mockHttp, mockResponses, mockNetworkError };
