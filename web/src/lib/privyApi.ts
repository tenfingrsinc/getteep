export type GetPrivyAccessToken = () => Promise<string | null>;

function sessionError() {
  return new Error("Your Teep session expired. Sign in again.");
}

async function requestWithCurrentToken(
  getAccessToken: GetPrivyAccessToken,
  input: RequestInfo | URL,
  init: RequestInit,
) {
  const token = await getAccessToken();
  if (!token) throw sessionError();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

/**
 * Calls a Teep endpoint with Privy's short-lived access token. Privy owns token
 * persistence and refresh; Teep deliberately never copies auth tokens into web
 * storage. A single 401 retry handles an access token that expired in-flight.
 */
export async function privyAuthorizedFetch(
  getAccessToken: GetPrivyAccessToken,
  input: RequestInfo | URL,
  init: RequestInit = {},
) {
  let response = await requestWithCurrentToken(getAccessToken, input, init);
  if (response.status !== 401) return response;
  response = await requestWithCurrentToken(getAccessToken, input, init);
  return response;
}
