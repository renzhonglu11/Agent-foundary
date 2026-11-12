import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import App from './App.jsx';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// Palette from the Positions report preview: a muted ink-blue accent,
// blue-grey neutrals, and status colours that tint chips instead of filling
// them with saturated colour.
const tokens = {
  bg: '#f6f8fb',
  surface: '#ffffff',
  surface2: '#eef3f9',
  ink: '#142233',
  ink2: '#4a5a6c',
  ink3: '#748396',
  line: '#d9e2ec',
}

const theme = createTheme({
  palette: {
    mode: 'light',
    background: { default: tokens.bg, paper: tokens.surface },
    primary: { main: '#1f5fa8', light: '#e3eefa', dark: '#174a84', contrastText: '#ffffff' },
    secondary: { main: '#5b6b8c', light: '#eceff5', dark: '#435069' },
    success: { main: '#17803d', light: '#e6f5ec', dark: '#12632f', contrastText: '#ffffff' },
    error: { main: '#c23a33', light: '#fdecea', dark: '#9a2c27', contrastText: '#ffffff' },
    warning: { main: '#b26b00', light: '#fff4e0', dark: '#8a5200', contrastText: '#ffffff' },
    info: { main: '#2b72c2', light: '#e6f0fb', dark: '#1f5fa8', contrastText: '#ffffff' },
    text: { primary: tokens.ink, secondary: tokens.ink2, disabled: tokens.ink3 },
    divider: tokens.line,
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: ['"Noto Sans SC"', 'Inter', '"PingFang SC"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'].join(','),
    h3: { fontFamily: '"Space Grotesk", "Noto Sans SC", sans-serif', fontWeight: 700, letterSpacing: '-0.02em', color: tokens.ink },
    h4: { fontFamily: '"Space Grotesk", "Noto Sans SC", sans-serif', fontWeight: 700, letterSpacing: '-0.015em' },
    h5: { fontFamily: '"Space Grotesk", "Noto Sans SC", sans-serif', fontWeight: 700 },
    h6: { fontFamily: '"Space Grotesk", "Noto Sans SC", sans-serif', fontWeight: 700 },
    subtitle1: { fontFamily: '"Space Grotesk", "Noto Sans SC", sans-serif' },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { backgroundColor: tokens.bg },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          border: `1px solid ${tokens.line}`,
          boxShadow: 'none',
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        outlined: { borderColor: tokens.line },
      },
    },
    MuiChip: {
      styleOverrides: {
        // Filled status chips become soft tints with dark text.
        root: ({ ownerState, theme: current }) => ({
          fontWeight: 700,
          ...(ownerState.variant !== 'outlined' && ownerState.color && ownerState.color !== 'default' && current.palette[ownerState.color] ? {
            backgroundColor: current.palette[ownerState.color].light,
            color: current.palette[ownerState.color].dark,
            '& .MuiChip-icon': { color: current.palette[ownerState.color].dark },
            '&.MuiChip-clickable:hover': { backgroundColor: current.palette[ownerState.color].light, filter: 'brightness(0.97)' },
          } : {}),
        }),
      },
    },
    MuiTableCell: {
      styleOverrides: {
        head: { color: tokens.ink2, backgroundColor: tokens.surface2 },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: { textTransform: 'none', fontWeight: 700, boxShadow: 'none', '&:hover': { boxShadow: 'none' } },
      },
    },
    MuiAlert: {
      styleOverrides: {
        standardInfo: { backgroundColor: '#e3eefa', color: tokens.ink },
        standardWarning: { backgroundColor: '#fff4e0', color: tokens.ink },
      },
    },
    MuiButtonBase: {
      defaultProps: {
        disableRipple: true,
      },
    },
  },
});

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <App />
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
