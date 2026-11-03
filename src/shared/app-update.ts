export interface AppUpdateState {
  currentVersion: string
  supported: boolean
  autoCheck: boolean
  status: 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'downloaded' | 'restarting' | 'error'
  version?: string
  releaseNotes?: string
  percent?: number
  error?: string
}
