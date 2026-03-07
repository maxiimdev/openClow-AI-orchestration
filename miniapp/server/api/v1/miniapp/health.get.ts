import { getHealthReport } from '../../../lib/health-telemetry'

export default defineEventHandler(() => {
  return getHealthReport()
})
