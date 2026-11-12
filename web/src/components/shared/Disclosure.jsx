import { Accordion, AccordionDetails, AccordionSummary, Box, Tooltip, Typography } from '@mui/material'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'

// Short headers with their definition on hover or focus, and collapsed
// blocks whose content mounts only when opened.

export function InfoTip({ title, label }) {
  return (
    <Tooltip title={title} arrow enterTouchDelay={0}>
      <Box component="span" tabIndex={0} aria-label={label ?? (typeof title === 'string' ? title : undefined)} sx={{ display: 'inline-flex', verticalAlign: 'middle', ml: 0.25, color: 'text.disabled', cursor: 'help', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', borderRadius: '50%' } }}>
        <InfoOutlinedIcon sx={{ fontSize: 15 }} />
      </Box>
    </Tooltip>
  )
}

export function Label({ children, tip }) {
  return <>{children}{tip ? <InfoTip title={tip} /> : null}</>
}

// A collapsed block whose content mounts only when opened.
// Pass `expanded` and `onChange` to control it from outside.
export function Section({ id, title, summary, defaultExpanded = false, expanded, onChange, keepMounted = false, children }) {
  const controlled = expanded === undefined ? {} : { expanded, onChange: (_event, next) => onChange?.(next) }
  return (
    <Accordion id={id} defaultExpanded={defaultExpanded} {...controlled} disableGutters variant="outlined" slotProps={{ transition: { unmountOnExit: !keepMounted } }} sx={{ borderRadius: 2, '&:before': { display: 'none' }, overflow: 'hidden' }}>
      <AccordionSummary expandIcon={<ExpandMoreRoundedIcon />} sx={{ minHeight: 48 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" fontWeight={800}>{title}</Typography>
          {summary ? <Typography variant="caption" color="text.secondary" component="div">{summary}</Typography> : null}
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>{children}</AccordionDetails>
    </Accordion>
  )
}
