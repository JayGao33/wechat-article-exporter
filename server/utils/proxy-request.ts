import dayjs from 'dayjs';


import { H3Event, parseCookies } from 'h3';
import { v4 as uuidv4 } from 'uuid';
import { isDev, USER_AGENT } from '~/config';
import { RequestOptions } from '~/server/types';
import { cookieStore, getCookieFromStore } from '~/server/utils/CookieStore';
import { logRequest, logResponse } from '~/server/utils/logger';

/**
 * 微信接口全局限流控制
 *
 * 背景：微信对公众号后台接口有频率限制（200013: freq control），且是针对整个登录账号的。
 * 一旦短时间内请求过于密集，就会被微信风控限制，导致搜索/登录/拉文章全部失败。
 *
 * 这里按 auth-key 做最小请求间隔排队：同一账号的微信请求之间至少间隔 MP_REQUEST_INTERVAL_MS，
 * 超出间隔的请求会等待，避免突发请求触发微信限流。
 *
 * 注意：Cloudflare Workers 单实例内存 Map 即可满足需求；如有多个隔离实例，
 * 误差可接受，此机制是尽力而为的"减震器"而非严格节流。
 */
const MP_REQUEST_INTERVAL_MS = 2500; // 同一账号两次微信请求的最小间隔
const lastRequestTimeMap = new Map<string, number>(); // authKey -> 上次请求时间戳(ms)

/**
 * 等待直到允许发起下一次微信请求（按 auth-key 排队）
 * @param authKey 登录凭证
 */
async function waitForMpRequestSlot(authKey: string): Promise<void> {
  if (!authKey) return;

  const now = Date.now();
  const lastTime = lastRequestTimeMap.get(authKey) || 0;
  const elapsed = now - lastTime;
  const waitMs = Math.max(0, MP_REQUEST_INTERVAL_MS - elapsed);

  if (waitMs > 0) {
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }

  lastRequestTimeMap.set(authKey, Date.now());
}

/**
 * 判断微信响应是否为限流错误
 * @param body 已解析的 JSON 响应体
 */
function isFreqControl(body: any): boolean {
  return !!body && body.base_resp && body.base_resp.ret === 200013;
}

/**
 * 代理微信公众号请求
 * @description 备注：只有登录请求(`action=login`)中的 `set-cookie` 才会被写入到 CookieStore 中
 * @param options 请求参数
 */
export async function proxyMpRequest(options: RequestOptions) {
  const runtimeConfig = useRuntimeConfig();

  const headers = new Headers({
    Referer: 'https://mp.weixin.qq.com/',
    Origin: 'https://mp.weixin.qq.com',
    'User-Agent': USER_AGENT,
    'Accept-Encoding': 'identity', // 禁用压缩，避免出现response.clone() bug
  });

  // 优先读取参数中的 cookie，若无则从 CookieStore 中读取
  const cookie: string | null = options.cookie || (await getCookieFromStore(options.event));
  if (cookie) {
    headers.set('Cookie', cookie);
  }

  // 全局限流：同一账号的微信请求排队，最小间隔 MP_REQUEST_INTERVAL_MS
  const authKey = getAuthKeyFromRequest(options.event);
  await waitForMpRequestSlot(authKey);

  const requestInit: RequestInit = {
    method: options.method,
    headers: headers,
    redirect: options.redirect || 'follow',
  };

  // 处理参数
  if (options.query) {
    options.endpoint += '?' + new URLSearchParams(options.query as Record<string, string>).toString();
  }
  if (options.method === 'POST' && options.body) {
    requestInit.body = new URLSearchParams(options.body as Record<string, string>).toString();
  }

  // 构造请求
  const request = new Request(options.endpoint, requestInit);

  // 记录请求报文
  const requestId = uuidv4().replace(/-/g, '');
  if (process.env.NUXT_DEBUG_MP_REQUEST && isDev) {
    await logRequest(requestId, request.clone());
  }

  // 转发请求
  const mpResponse = await fetch(request);

  // 记录响应报文
  if (process.env.NUXT_DEBUG_MP_REQUEST && isDev) {
    await logResponse(requestId, mpResponse.clone());
  }

  let setCookies: string[] = [];

  // 处理登录请求的 uuid cookie
  if (options.action === 'start_login') {
    // 提取出 uuid 这个 cookie，并透传给客户端
    setCookies = mpResponse.headers.getSetCookie().filter(cookie => cookie.startsWith('uuid='));
  }

  // 处理登录成功请求的 cookie
  // 只有登录请求才会将 Cookie 数据写入 CookieStore
  // 返回给客户端的一个 auth-key 的 cookie
  else if (options.action === 'login') {
    // 提取出 token 和 cookies
    try {
      const authKey = crypto.randomUUID().replace(/-/g, '');

      const body = await mpResponse.clone().json();
      const redirectUrl = body?.redirect_url;
      if (!redirectUrl || typeof redirectUrl !== 'string') {
        throw new Error(`登录响应中未找到 redirect_url，响应内容: ${JSON.stringify(body)}`);
      }

      const token = new URL(`http://localhost${redirectUrl}`).searchParams.get('token');
      if (!token) {
        throw new Error(`redirect_url 中未找到 token 参数: ${redirectUrl}`);
      }

      console.log('token', token);
      const success = await cookieStore.setCookie(authKey, token, mpResponse.headers.getSetCookie());
      if (!success) {
        throw new Error('cookie 写入 KV 存储失败');
      }
      console.log('cookie 写入成功');

      setCookies = [
        `auth-key=${authKey}; Path=/; Expires=${dayjs().add(4, 'days').toString()}; Secure; HttpOnly`,

        // 登录成功后，删除浏览器的 uuid cookie
        `uuid=EXPIRED; Path=/; Expires=${dayjs().subtract(1, 'days').toString()}; Secure; HttpOnly`,
      ];
    } catch (error) {
      console.error('action(login) failed:', error);

      // 登录失败时返回错误响应，而不是静默继续
      return new Response(JSON.stringify({ base_resp: { ret: -1, err_msg: `登录处理失败: ${error}` } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // 处理切换公众号的请求
  else if (options.action === 'switch_account') {
    const authKey = getAuthKeyFromRequest(options.event);
    if (authKey) {
      setCookies = ['switch_account=1'];
    }
  }

  // 这里是否需要执行？
  // 更新 CookieStore 中的 cookie
  else {
    // updateCookies(options.event, mpResponse.headers.getSetCookie());
  }

  // 构造返回给客户端的响应
  const responseHeaders = new Headers(mpResponse.headers);
  responseHeaders.delete('set-cookie');
  setCookies.forEach(setCookie => {
    responseHeaders.append('set-cookie', setCookie);
  });

  const finalResponse = new Response(mpResponse.body, {
    status: mpResponse.status,
    statusText: mpResponse.statusText,
    headers: responseHeaders,
  });
  if (!options.parseJson) {
    return finalResponse;
  } else {
    const json = await finalResponse.json();

    // 限流（200013）不抛异常（否则会变成 HTTP 500，丢失限流特征），
    // 直接返回微信原始 JSON（含 ret=200013），由前端 getArticleList 识别并退避重试
    return json;
  }
}

export function getAuthKeyFromRequest(event: H3Event): string {
  let authKey = getRequestHeader(event, 'X-Auth-Key');
  if (!authKey) {
    const cookies = parseCookies(event);
    authKey = cookies['auth-key'];
  }

  return authKey;
}

// function updateCookies(event: H3Event, cookies: string[]): void {
//   const authKey = getAuthKeyFromRequest(event);
//   if (authKey) {
//     cookieStore.updateCookie(authKey, cookies);
//   }
// }
