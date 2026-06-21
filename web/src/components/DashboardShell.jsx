import { useState } from 'react';
import { AppBar, Badge, Box, Container, IconButton, Stack, Tab, Tabs, Toolbar, Typography } from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import NotificationsIcon from '@mui/icons-material/Notifications';
import SidebarNav, { navItems, sidebarCollapsedWidth, sidebarExpandedWidth } from './SidebarNav.jsx';
import DataImportSpeedDial from './DataImportSpeedDial.jsx';

export default function DashboardShell({ source, generatedAt, activeTab, onTabChange, children, pnlRecords = [], onRemovePnlRecord }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const sidebarWidth = sidebarCollapsed ? sidebarCollapsedWidth : sidebarExpandedWidth;
  const drawerOpen = !sidebarCollapsed;
  const handleSidebarToggle = () => setSidebarCollapsed((value) => !value);
  const handleDrawerClickAway = () => {
    if (drawerOpen) {
      setSidebarCollapsed(true);
    }
  };

  return (
    <Box className="dashboard-bg" sx={{ minHeight: '100vh' }}>
      <AppBar
        position="fixed"
        onClick={handleDrawerClickAway}
        sx={{
          zIndex: (theme) => theme.zIndex.drawer + 1,
          bgcolor: 'primary.main',
          boxShadow: '0 2px 10px rgba(42, 53, 71, 0.12)',
          transition: (theme) => theme.transitions.create(['width', 'margin'], {
            easing: theme.transitions.easing.sharp,
            duration: drawerOpen
              ? theme.transitions.duration.enteringScreen
              : theme.transitions.duration.leavingScreen,
          }),
          ...(drawerOpen && {
            ml: `${sidebarExpandedWidth}px`,
            width: `calc(100% - ${sidebarExpandedWidth}px)`,
          }),
        }}
      >
        <Toolbar>
          <IconButton
            size="large"
            edge="start"
            color="inherit"
            aria-label="toggle navigation drawer"
            onClick={handleSidebarToggle}
            sx={[
              { mr: 2 },
              drawerOpen && { display: 'none' },
            ]}
          >
            <MenuIcon />
          </IconButton>
          <Typography
            variant="h6"
            noWrap
            component="div"
            sx={{ display: { xs: 'none', sm: 'block' }, fontWeight: 800 }}
          >
            Agent-Foundry
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          <IconButton size="large" aria-label="show notifications" color="inherit">
            <Badge variant="dot" color="error">
              <NotificationsIcon />
            </Badge>
          </IconButton>
        </Toolbar>
      </AppBar>

      <SidebarNav
        activeTab={activeTab}
        onChange={onTabChange}
        collapsed={sidebarCollapsed}
        onToggle={handleSidebarToggle}
      />
      <Box
        component="main"
        onClick={handleDrawerClickAway}
        sx={{
          width: { xs: '100%', md: `calc(100% - ${sidebarWidth}px)` },
          ml: { xs: 0, md: `${sidebarWidth}px` },
          minWidth: 0,
          pt: { xs: 0, md: 0 },
          pb: { xs: 3, md: 5 },
          transition: 'margin-left 180ms ease, width 180ms ease',
        }}
      >
        <Toolbar />
        <Container maxWidth="xl">
          <Stack spacing={4} sx={{ pt: { xs: 2, md: 3 } }}>
            <Box sx={{ display: { xs: 'block', md: 'none' } }}>
              <Tabs
                value={activeTab}
                onChange={(_, value) => onTabChange(value)}
                variant="scrollable"
                scrollButtons="auto"
                className="mobile-tabs"
              >
                {navItems.map((item) => <Tab key={item.id} value={item.id} label={item.label} />)}
              </Tabs>
            </Box>

            {children}
          </Stack>
        </Container>
      </Box>
      <DataImportSpeedDial pnlRecords={pnlRecords} onRemovePnlRecord={onRemovePnlRecord} />
    </Box>
  );
}
