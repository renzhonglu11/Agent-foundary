import { Box, LinearProgress, Snackbar, Stack, Typography } from '@mui/material'

export default function RealtimeEnrichmentSnackbar({ open, progress }) {
  return (
    <Snackbar
      open={open}
      anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      message={(
        <Box sx={{ width: { xs: 280, sm: 420 } }}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Typography variant="body2" fontWeight={800}>Realtime enrichment</Typography>
            <Typography variant="caption">{progress.percent}%</Typography>
          </Stack>
          <LinearProgress variant="determinate" value={progress.percent} />
          <Typography variant="caption" sx={{ display: 'block', mt: 0.75 }}>
            {progress.total ? `${progress.current}/${progress.total} · ${progress.label}` : progress.label}
          </Typography>
        </Box>
      )}
    />
  )
}
