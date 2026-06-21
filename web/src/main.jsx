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

const theme = createTheme({
  palette: {
    mode: 'light',
    background: { default: '#f6f9fc', paper: '#ffffff' },
    primary: { main: '#5d87ff', light: '#ecf2ff', dark: '#4570ea' },
    secondary: { main: '#635bff', light: '#ede7ff' },
    success: { main: '#13deb9', light: '#e6fffa' },
    error: { main: '#fa896b', light: '#fdede8' },
    warning: { main: '#ffae1f', light: '#fef5e5' },
    info: { main: '#49beff', light: '#e8f7ff' },
    text: { primary: '#2a3547', secondary: '#7c8fac' },
    divider: '#e5eaef',
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: ['Plus Jakarta Sans', 'Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'].join(','),
    h3: { fontWeight: 800, letterSpacing: '-0.035em', color: '#2a3547' },
    h4: { fontWeight: 800, letterSpacing: '-0.025em' },
    h5: { fontWeight: 750 },
    h6: { fontWeight: 700 },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: '#f6f9fc',
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          border: '1px solid #e5eaef',
          boxShadow: '0 2px 6px rgba(37, 83, 185, 0.04), 0 12px 28px rgba(42, 53, 71, 0.06)',
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 700,
        },
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
