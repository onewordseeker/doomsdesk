import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { v4 as uuidv4 } from 'uuid'

interface Config {
  deviceId: string
  permanentPassword: string
  theme: 'dark' | 'light' | 'system'
  startMinimized: boolean
  launchOnStartup: boolean
  serverUrl: string
  webUrl: string
}

const DEFAULTS: Omit<Config, 'deviceId'> = {
  permanentPassword: '',
  theme: 'dark',
  startMinimized: false,
  launchOnStartup: false,
  serverUrl: 'ws://72.62.66.94:4001',
  webUrl: 'http://72.62.66.94:4000',
}

function generateDeviceId(): string {
  const digits = uuidv4().replace(/\D/g, '').slice(0, 9).padStart(9, '0')
  return digits.replace(/(\d{3})(\d{3})(\d{3})/, '$1-$2-$3')
}

function getConfigPath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'config.json')
}

let _cache: Config | null = null

function load(): Config {
  if (_cache) return _cache
  const path = getConfigPath()
  if (existsSync(path)) {
    try {
      _cache = { ...DEFAULTS, deviceId: '', ...JSON.parse(readFileSync(path, 'utf-8')) }
      if (!_cache!.deviceId) { _cache!.deviceId = generateDeviceId(); save() }
      return _cache!
    } catch {}
  }
  _cache = { ...DEFAULTS, deviceId: generateDeviceId() }
  save()
  return _cache
}

function save(): void {
  writeFileSync(getConfigPath(), JSON.stringify(_cache, null, 2), 'utf-8')
}

export function getConfig(): Config {
  return load()
}

export function setConfig(partial: Partial<Config>): void {
  Object.assign(load(), partial)
  save()
}

export function getDeviceId(): string {
  return load().deviceId
}

export function getPermanentPassword(): string {
  return load().permanentPassword
}
