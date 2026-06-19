import {
  Box,
  IconButton,
  InputAdornment,
  OutlinedInput,
  Typography,
} from '@mui/material'
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown'
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp'
import { NumberField as BaseNumberField } from '@base-ui/react/number-field'

export default function NumberField({
  value,
  onChange,
  startAdornment,
  suffix,
  width = 104,
  inputSx,
  ariaLabel,
  format,
  step = 0.1,
  smallStep = 0.1,
  largeStep = 1,
}) {
  return (
    <BaseNumberField.Root
      value={value ?? null}
      onValueChange={(nextValue) => onChange(nextValue)}
      step={step}
      smallStep={smallStep}
      largeStep={largeStep}
      format={{
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
        ...format,
      }}
    >
      <BaseNumberField.Input
        aria-label={ariaLabel}
        render={(props, state) => (
          <OutlinedInput
            inputRef={props.ref}
            value={state.inputValue}
            onBlur={props.onBlur}
            onChange={props.onChange}
            onKeyUp={props.onKeyUp}
            onKeyDown={props.onKeyDown}
            onFocus={props.onFocus}
            startAdornment={startAdornment}
            endAdornment={
              <InputAdornment
                position="end"
                sx={{
                  alignSelf: 'stretch',
                  maxHeight: 'unset',
                  ml: 0,
                  '& .MuiIconButton-root': {
                    py: 0,
                    px: 0.45,
                    minWidth: 24,
                    flex: 1,
                    borderRadius: 0.5,
                  },
                }}
              >
                {suffix ? (
                  <Typography component="span" color="text.secondary" sx={{ fontSize: '0.72rem', mr: 0.5 }}>
                    {suffix}
                  </Typography>
                ) : null}
                <Box
                  sx={{
                    alignSelf: 'stretch',
                    display: 'flex',
                    flexDirection: 'column',
                    borderLeft: '1px solid',
                    borderColor: 'divider',
                  }}
                >
                  <BaseNumberField.Increment render={<IconButton size="small" aria-label="Increase" />}>
                    <KeyboardArrowUpIcon fontSize="small" sx={{ transform: 'translateY(2px)' }} />
                  </BaseNumberField.Increment>
                  <BaseNumberField.Decrement render={<IconButton size="small" aria-label="Decrease" />}>
                    <KeyboardArrowDownIcon fontSize="small" sx={{ transform: 'translateY(-2px)' }} />
                  </BaseNumberField.Decrement>
                </Box>
              </InputAdornment>
            }
            size="small"
            slotProps={{
              input: {
                ...props,
                sx: {
                  textAlign: 'right',
                },
              },
            }}
            sx={{
              fontSize: '0.78rem',
              width,
              fontVariantNumeric: 'tabular-nums',
              backgroundColor: '#fff',
              pr: 0,
              '& .MuiOutlinedInput-input': {
                py: 0.45,
                px: 0.75,
              },
              ...inputSx,
            }}
          />
        )}
      />
    </BaseNumberField.Root>
  )
}
