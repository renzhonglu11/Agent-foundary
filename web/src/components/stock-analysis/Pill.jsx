import { Box } from '@mui/material'

export default function Pill({ label, meta }) {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1,
        py: 0.25,
        borderRadius: '6px',
        border: `1px solid ${meta.border}`,
        backgroundColor: meta.bg,
        color: '#2a3547',
        fontSize: 13,
        fontWeight: 700,
        lineHeight: 1.35,
        whiteSpace: 'nowrap',
      }}
    >
      <Box component="span" sx={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: meta.color, flexShrink: 0 }} />
      {label}
    </Box>
  )
}
