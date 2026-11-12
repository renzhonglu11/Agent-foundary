import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material'
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded'

const time = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export default function HermesReview({ status, review, selectedPortfolioId, disabledReason, onRequest }) {
  const selected = (review.data?.reviews || []).find(item => item.portfolioId === selectedPortfolioId)
  const unavailable = !status.available
  return (
    <Box sx={{ border: '1px solid #e5eaef', borderRadius: 2, p: 1.25, backgroundColor: '#ffffff' }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Button size="small" variant="outlined" startIcon={review.loading ? <CircularProgress size={14} /> : <AutoAwesomeRoundedIcon />}
          disabled={unavailable || review.loading || Boolean(disabledReason)} onClick={onRequest} sx={{ textTransform: 'none' }}>
          {review.loading ? '正在解读…' : review.data ? '重新解读' : 'Hermes 解读方案取舍'}
        </Button>
        <Typography variant="caption" color="text.secondary">
          {disabledReason || (status.loading ? '检查 Hermes…' : status.available ? status.model || '已就绪' : '当前环境没有 Hermes，以上本地计算不受影响')}
        </Typography>
      </Stack>
      {review.error ? <Alert severity="info" sx={{ mt: 1 }}>{review.error.message}</Alert> : null}
      {review.data?.summary ? (
        <Alert severity="info" sx={{ mt: 1 }}>
          {review.data.summary}
          {selected ? <Typography variant="body2" sx={{ mt: 0.5 }}>{selected.verdict}：{selected.reason}{selected.risks?.length ? `；风险：${selected.risks.join('；')}` : ''}</Typography> : null}
        </Alert>
      ) : null}
      {review.data && review.stale ? (
        <Typography variant="caption" color="warning.main" component="div" sx={{ mt: 0.5 }}>
          这份解读基于 {time(review.at)} 的数据；之后行情已刷新，上方数字可能与解读略有不同。
        </Typography>
      ) : null}
    </Box>
  )
}
