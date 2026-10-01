export interface AppUpdateState {
  currentVersion: string
  supported: boolean
  autoCheck: boolean
  status: 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'downloaded' | 'error'
  version?: string
  percent?: number
  error?: string
}
