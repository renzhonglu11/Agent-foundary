import { Box, Typography } from '@mui/material'
import { COVERAGE_TERMS } from '../../utils/labels.js'
import { InfoTip } from './Disclosure.jsx'

// Explains all three coverage measures, with the one shown here first.
export default function CoverageTip({ current }) {
  const terms = [...COVERAGE_TERMS].sort((left, right) => (right.id === current) - (left.id === current))
  return (
    <InfoTip
      label="三种覆盖率口径说明"
      title={(
        <Box sx={{ display: 'grid', gap: 0.75, py: 0.25 }}>
          {terms.map(term => (
            <Box key={term.id}>
              <Typography variant="caption" fontWeight={term.id === current ? 800 : 600} component="div">
                {term.name}{term.id === current ? '（此处）' : ''}
              </Typography>
              <Typography variant="caption" component="div" sx={{ opacity: term.id === current ? 1 : 0.8 }}>{term.text}</Typography>
            </Box>
          ))}
        </Box>
      )}
    />
  )
}
