import { storage } from 'webextension-polyfill'
import type {
  ICaptchaRequest,
  ICaptchaResponse,
  IRoleDataItem,
  IUserData,
  IUserDataItem,
  serverRegions,
} from '../types'
import { md5 } from './md5'
import type { AdvancedHeaders } from './advancedFetch'
import { advancedFetch } from './advancedFetch'

function randomIntFromInterval(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1) + min)
}

// 向storage写入数据
export const writeDataToStorage = async function <T>(key: string, data: T) {
  await storage.local.set({ [key]: data })
}

export const range = (start: number, end: number) =>
  Array.from({ length: end - start + 1 }, (_, i) => start + i)

// 从storage读取数据
export const readDataFromStorage = async function <T>(
  key: string,
  defaultVal: T,
): Promise<T> {
  const data = await storage.local.get(key)
  if (data[key] !== undefined)
    return data[key]
  else return defaultVal
}

function uuid() {
  function S4() {
    return (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1)
  }

  return `${S4() + S4()}-${S4()}-${S4()}-${S4()}-${S4()}${S4()}${S4()}`
}

export function generateSeed(length = 16) {
  const characters = '0123456789abcdef'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += characters[Math.floor(Math.random() * characters.length)]
  }
  return result
}

// 随机生成的 deviceId
export const getDeviceId = async () => {
  // 首先尝试从 storage 中读取 deviceId
  let deviceId = await readDataFromStorage('deviceId', '')

  // 如果 storage 中没有 deviceId，则生成一个新的 deviceId
  if (deviceId === '') {
    deviceId = uuid()
    await writeDataToStorage('deviceId', deviceId)
  }

  return deviceId
}

function getTime(time: number) {
  const hh = ~~(time / 3600)
  const mm = ~~((time % 3600) / 60)

  // return `${hh}小时${mm}分钟`
  return {
    hour: hh,
    minute: mm,
  }
}

function getClock(time: number) {
  const timeNow = Date.now()
  const now = new Date(timeNow)
  const hoursNow = now.getHours()
  const minutesNow = now.getMinutes() * 60 * 1000
  const secondsNow = now.getSeconds() * 1000
  const timeRecovery = new Date(timeNow + time * 1000)

  const tillTomorrow = (24 - hoursNow) * 3600 * 1000
  const tomorrow = new Date(timeNow + tillTomorrow - minutesNow - secondsNow)

  let str = ''
  if (timeRecovery < tomorrow)
    str = 'today'
  else str = 'tomorrow'

  return {
    day: str as 'today' | 'tomorrow',
    hour: timeRecovery.getHours().toString().padStart(2, '0'),
    minute: timeRecovery.getMinutes().toString().padStart(2, '0'),
  }
}

function stringifyParams(params: Record<string, string>) {
  // 字典序处理
  const keys = Object.keys(params)
  keys.sort()
  const values: string[] = []
  keys.forEach((key) => {
    values.push(`${key}=${params[key]}`)
  })

  // 转字符串
  const paramsStr = values.join('&')
  return paramsStr
}

function getDS(oversea: boolean, params: Record<string, string>, body: object) {
  const timestamp = Math.floor(Date.now() / 1000)
  const randomStr = randomIntFromInterval(100000, 200000)
  const bodyStr
    = body && Object.keys(body).length > 0 ? JSON.stringify(body) : ''
  const paramStr
    = params && Object.keys(params).length > 0 ? stringifyParams(params) : ''
  const salt = oversea
    ? 'okr4obncj8bw5a65hbnn5oo6ixjc3l9w'
    : 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs'
  const text = `salt=${salt}&t=${timestamp}&r=${randomStr}&b=${bodyStr}&q=${paramStr}`
  const sign = md5(text)
  return `${timestamp},${randomStr},${sign}`
}

const MIYOUSHE_VERSION = '2.58.2'

const HEADER_TEMPLATE_CN: Record<string, string> = {
  'x-rpc-app_version': MIYOUSHE_VERSION,
  'User-Agent': `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) miHoYoBBS/${MIYOUSHE_VERSION}`,
  'x-rpc-client_type': '5',
  'x-rpc-sys_version': '17.0',
  'x-rpc-tool_version': 'v1.3.1-rpg',
  'x-rpc-device_name': 'iPhone',
  'Origin': 'https://webstatic.mihoyo.com',
  'X-Requested-With': 'com.mihoyo.hyperion',
  'x-rpc-page': 'v1.3.1-rpg_#/rpg',
  'Referer': 'https://webstatic.mihoyo.com/',
  'sec-fetch-dest': 'empty',
  'sec-fetch-site': 'same-site',
}

const HEADER_TEMPLATE_OS: Record<string, string> = {
  'x-rpc-app_version': '2.22.0',
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) miHoYoBBSOversea/2.22.0',
  'x-rpc-client_type': '2',
  'Origin': 'https://act.hoyolab.com',
  'X-Requested-With': 'com.mihoyo.hoyolab',
  'Referer': 'https://act.hoyolab.com',
}

async function getHeader(
  oversea: boolean,
  params: Record<string, string>,
  body: object,
  ds: boolean,
) {
  const client = oversea ? HEADER_TEMPLATE_OS : HEADER_TEMPLATE_CN
  const headers = { ...client }

  if (ds) {
    const dsStr = getDS(oversea, params, body)
    headers.DS = dsStr
  }

  headers['x-rpc-device_id'] = (await getDeviceId()).toUpperCase()
  return headers
}

async function getRoleInfoByCookie(
  oversea: boolean,
  cookie: string,
): Promise<IRoleDataItem[] | false> {
  // 根据 oversea 参数选择对应 api 地址
  const url = oversea
    ? 'https://api-os-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie?game_biz=hkrpg_global'
    : 'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookieToken?game_biz=hkrpg_cn'

  // 生成 header
  const headers = await getHeader(oversea, {}, {}, false)

  headers.Cookie = cookie

  // 发送请求
  const _ret = await advancedFetch(url, {
    method: 'GET',
    headers,
  })
    .then((response) => {
      return response.json()
    })
    .then((data) => {
      if (data.retcode === 0)
        return data.data.list
      else return false
    })
    .catch(() => {
      return false
    })
  return _ret
}

async function getRoleDataByCookie(
  oversea: boolean,
  cookie: string,
  role_id: string,
  serverRegion: serverRegions,
): Promise<IUserData | false | number> {
  // 根据 oversea 参数选择对应 api 地址
  const url = new URL(
    oversea
      ? 'https://bbs-api-os.hoyolab.com/game_record/app/hkrpg/api/note'
      : 'https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api/note',
  )

  // 补全 url query
  const params = {
    server: serverRegion,
    role_id,
  }

  for (const [key, value] of Object.entries(params))
    url.searchParams.append(key, value)

  // 生成 header
  const headers = await getHeader(oversea, params, {}, true)

  if (!oversea) {
    // 为 header 追加 fp
    await appendDeviceFp(headers, role_id, cookie)
    await appendChallenge(headers, role_id)
  }

  headers.Cookie = cookie

  // 发送请求
  const _ret = await advancedFetch(url.toString(), {
    method: 'GET',
    headers,
  })
    .then(async (response) => {
      const headers = response.headers
      await writeDataToStorage(
        `traceId_${role_id}`,
        headers.get('x-trace-id') || '',
      )
      return response.json()
    })
    .then((data) => {
      if (data.retcode === 0) {
        return data.data
      } else if (data.retcode === 1034) {
        // risk control
        return 1034
      } else {
        writeDataToStorage(`deviceFp_${role_id}_request`, true)
        return false
      }
    })
    .catch(() => {
      return false
    })
  return _ret
}

async function createVerification(
  oversea: boolean,
  cookie: string,
  uid: string,
): Promise<ICaptchaResponse | false> {
  // 根据 oversea 参数选择对应 api 地址
  const url = new URL(
    oversea
      ? 'https://api-takumi-record.mihoyo.com/game_record/app/card/wapi/createVerification'
      : 'https://api-takumi-record.mihoyo.com/game_record/app/card/wapi/createVerification',
  )

  // 补全 url query
  const params = {
    is_high: 'true',
  }

  for (const [key, value] of Object.entries(params))
    url.searchParams.append(key, value)

  // 生成 header
  const headers = await getHeader(oversea, params, {}, true)

  // 为 header 追加 cookie
  headers.Cookie = cookie

  // 为 header 追加 x-rpc-challenge_path
  headers['x-rpc-challenge_path']
    = 'https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api/note'
  headers['x-rpc-challenge_game'] = '6'

  const traceId = await readDataFromStorage(`traceId_${uid}`, '')

  if (traceId !== '') {
    headers['x-rpc-challenge_trace'] = traceId
  }

  if (!oversea) {
    // 为 header 追加 fp
    await appendDeviceFp(headers, uid, cookie)
  }

  // 发送请求
  const _ret = await advancedFetch(url.toString(), {
    method: 'GET',
    headers,
  })
    .then((response) => response.json())
    .then((data) => {
      if (data.retcode === 0)
        return data.data
      else return false
    })
    .catch(() => {
      return false
    })
  return _ret
}

async function verifyVerification(
  oversea: boolean,
  cookie: string,
  geetest: ICaptchaRequest,
  uid: string,
): Promise<boolean> {
  // 根据 oversea 参数选择对应 api 地址
  const url = new URL(
    oversea
      ? 'https://api-takumi-record.mihoyo.com/game_record/app/card/wapi/verifyVerification'
      : 'https://api-takumi-record.mihoyo.com/game_record/app/card/wapi/verifyVerification',
  )

  // 生成 header
  const headers = await getHeader(oversea, {}, geetest, true)

  // 为 header 追加 cookie
  headers.Cookie = cookie

  // 为 header 追加 x-rpc-challenge_path
  headers['x-rpc-challenge_path']
    = 'https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api/note'
  headers['x-rpc-challenge_game'] = '6'

  const traceId = await readDataFromStorage(`traceId_${uid}`, '')

  if (traceId !== '') {
    headers['x-rpc-challenge_trace'] = traceId
  }

  // 发送请求
  const _ret = await advancedFetch(url.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(geetest),
  })
    .then((response) => response.json())
    .then((data) => {
      if (data.retcode === 0) {
        writeDataToStorage(`challenge_${uid}`, data.data.challenge)
        return data.data
      } else {
        return false
      }
    })
    .catch(() => {
      return false
    })
  return _ret
}

export async function getUserFullInfo(cookie: string): Promise<any> {
  const url = 'https://bbs-api.mihoyo.com/user/wapi/getUserFullInfo?gids=2'
  const headers = {
    Cookie: cookie,
    Accept: 'application/json, text/plain, */*',
    Connection: 'keep-alive',
    Host: 'bbs-api.mihoyo.com',
    Origin: 'https://m.bbs.mihoyo.com',
    Referer: ' https://m.bbs.mihoyo.com/',
  }
  let res = await advancedFetch(url, {
    method: 'GET',
    headers,
  })

  if (!res.ok) {
    return false
  }
  res = await res.json()
  return res
}

const calcRoleDataLocally = (role: IUserDataItem) => {
  const _role: IUserDataItem = JSON.parse(JSON.stringify(role))

  const updateTimestamp = _role.updateTimestamp
  const curTimestamp = Date.now()

  const maxStamina = _role.data.max_stamina
  const curStamina = _role.data.current_stamina

  // 开拓力每 6 分钟恢复 1 点
  _role.data.current_stamina = Math.min(
    maxStamina,
    curStamina + Math.floor((curTimestamp - updateTimestamp) / 1000 / 60 / 6),
  )

  // 更新开拓力恢复时间 秒
  _role.data.stamina_recover_time
    = _role.data.stamina_recover_time
    - Math.floor((curTimestamp - updateTimestamp) / 1000)

  if (_role.data.expeditions && _role.data.expeditions.length > 0) {
    for (const expedition of _role.data.expeditions) {
      if (expedition.status === 'Ongoing') {
        // 单位为 秒
        const remainTime = Number(expedition.remaining_time)
        expedition.remaining_time = Math.max(
          0,
          remainTime - Math.floor((curTimestamp - updateTimestamp) / 1000),
        ).toString()
        if (expedition.remaining_time === '0')
          expedition.status = 'Finished'
      }
    }
  }

  return _role
}

async function getGeetestChallenge(
  oversea: boolean,
  challenge: string,
  gt: string,
): Promise<string | false> {
  const url = `https://apiv6.geetest.com/ajax.php?pt=3&client_type=web_mobile&lang=zh-cn&challenge=${challenge}&gt=${gt}`

  // 为 header 追加 cookie
  const headers = await getHeader(oversea, {}, {}, false)

  // 发送请求
  const _ret = await advancedFetch(url, {
    method: 'GET',
    headers,
  })
    .then((response) => {
      const data = response.text()
      return data
    })
    .then((text) => {
      const bracketLeft = text.indexOf('{')
      const bracketRight = text.lastIndexOf('}')
      return JSON.parse(text.substring(bracketLeft, bracketRight + 1))
    })
    .then((data) => {
      if (data.status === 'success') {
        if (data.data.result === 'success' && data.data.validate) {
          return data.data.validate
        } else {
          return false
        }
      } else {
        return false
      }
    })
    .catch(() => {
      return false
    })
  return _ret
}

export const generateDeviceFp = async (cookie: string) => {
  const seed = generateSeed(16)
  const time = `${Date.now()}`
  const deviceId = await getDeviceId()
  const ext_fields = JSON.stringify({
    userAgent: HEADER_TEMPLATE_CN['User-Agent'],
    browserScreenSize: 281520,
    maxTouchPoints: 5,
    isTouchSupported: true,
    browserLanguage: 'zh-CN',
    browserPlat: 'iPhone',
    browserTimeZone: 'Asia/Shanghai',
    webGlRender: 'Apple GPU',
    webGlVendor: 'Apple Inc.',
    numOfPlugins: 0,
    listOfPlugins: 'unknown',
    screenRatio: 3,
    deviceMemory: 'unknown',
    hardwareConcurrency: '4',
    cpuClass: 'unknown',
    ifNotTrack: 'unknown',
    ifAdBlock: 0,
    hasLiedResolution: 1,
    hasLiedOs: 0,
    hasLiedBrowser: 0,
  })
  const body = {
    seed_id: seed,
    device_id: deviceId.toUpperCase(),
    platform: '5',
    seed_time: time,
    ext_fields,
    app_name: 'account_cn',
    device_fp: '38d7ee834d1e9',
  }

  const url = 'https://public-data-api.mihoyo.com/device-fp/api/getFp'

  // 生成 header
  const headers = await getHeader(false, {}, body, false)
  // 为 header 追加 cookie
  headers.Cookie = cookie

  // 发送请求
  const _ret = await advancedFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
    .then((response) => {
      return response.json()
    })
    .then((data) => {
      if (data.data.code === 200) {
        return data.data.device_fp
      } else {
        console.error(new Error(`generateDeviceFp failed: ${data.data.msg}`))
        return generateSeed(13)
      }
    })
    .catch((e) => {
      console.error(e)
      return generateSeed(13)
    })
  return _ret
}

async function appendDeviceFp(
  headers: AdvancedHeaders,
  uid: string,
  cookie: string,
) {
  const deviceFpRefreshRequest = await readDataFromStorage(`deviceFp_${uid}_request`, false)

  let deviceFp = await readDataFromStorage(`deviceFp_${uid}`, '')

  // 如果 storage 中没有 deviceId，则生成一个新的 deviceId
  if (deviceFp === '' || deviceFpRefreshRequest) {
    deviceFp = await generateDeviceFp(cookie)
    await writeDataToStorage(`deviceFp_${uid}`, deviceFp)
  }
  await writeDataToStorage(`deviceFp_${uid}_count`, Date.now())
  headers['x-rpc-device_fp'] = deviceFp
  return headers
}

async function appendChallenge(headers: AdvancedHeaders, uid: string) {
  const challenge = await readDataFromStorage(`challenge_${uid}`, '')

  // 如果 storage 中没有 deviceId，则生成一个新的 deviceId
  if (challenge === '') {
    return headers
  }
  headers['x-rpc-chellange'] = challenge
  await writeDataToStorage(`challenge_${uid}`, '')
  return headers
}

export {
  md5,
  randomIntFromInterval,
  getTime,
  getClock,
  getDS,
  getHeader,
  getRoleInfoByCookie,
  getRoleDataByCookie,
  createVerification,
  verifyVerification,
  calcRoleDataLocally,
  getGeetestChallenge,
}

// 随机生成-5到5的整数
export const getRandomTimeOffset = () => {
  return Math.floor(Math.random() * 11) - 5
}
