export default defineEventHandler(async event => {
  const query = getQuery(event);
  const url = decodeURIComponent(query.url as string);
  const headersStr = decodeURIComponent((query.headers as string) || '{}');
  const headers = JSON.parse(headersStr);
  const authorization = query.authorization as string;

  const response = await fetch(url, {
    headers: {
      ...headers,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36 WAE/1.0',
      Referer: 'https://mp.weixin.qq.com/',
      ...(authorization ? { Authorization: authorization } : {}),
    },
  });

  return response;
});
