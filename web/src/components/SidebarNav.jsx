import { Box, Divider, Drawer, IconButton, List, ListItem, ListItemButton, ListItemIcon, ListItemText, Tooltip } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import DashboardRoundedIcon from '@mui/icons-material/DashboardRounded';
import PaidRoundedIcon from '@mui/icons-material/PaidRounded';
import AccountBalanceWalletRoundedIcon from '@mui/icons-material/AccountBalanceWalletRounded';
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded';
import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded';

const navItems = [
  { id: 'overview', label: 'Overview', subtitle: '总览', icon: DashboardRoundedIcon },
  { id: 'positions', label: 'Positions', subtitle: '持仓查询', icon: AccountBalanceWalletRoundedIcon },
  { id: 'dividend', label: 'Dividend', subtitle: '股息 / 利息', icon: PaidRoundedIcon },
  { id: 'stockAnalysis', label: 'Stock Picks', subtitle: '选股分析', icon: QueryStatsRoundedIcon },
  { id: 'hermesCron', label: 'Hermes Cron', subtitle: '定时任务状态', icon: ScheduleRoundedIcon },
];

export const sidebarExpandedWidth = 240;
export const sidebarCollapsedWidth = 65;

export default function SidebarNav({ activeTab, onChange, collapsed, onToggle }) {
  const theme = useTheme();
  const open = !collapsed;
  const drawerWidth = open ? sidebarExpandedWidth : sidebarCollapsedWidth;

  return (
    <Drawer
      variant="permanent"
      open={open}
      sx={{
        width: drawerWidth,
        flexShrink: 0,
        whiteSpace: 'nowrap',
        boxSizing: 'border-box',
        display: { xs: 'none', md: 'block' },
        transition: (theme) => theme.transitions.create('width', {
          easing: theme.transitions.easing.sharp,
          duration: open
            ? theme.transitions.duration.enteringScreen
            : theme.transitions.duration.leavingScreen,
        }),
        '& .MuiDrawer-paper': {
          width: drawerWidth,
          overflowX: 'hidden',
          whiteSpace: 'nowrap',
          boxSizing: 'border-box',
          borderRight: '1px solid #e5eaef',
          background: '#ffffff',
          boxShadow: '6px 0 24px rgba(42, 53, 71, 0.04)',
          transition: (theme) => theme.transitions.create('width', {
            easing: theme.transitions.easing.sharp,
            duration: open
              ? theme.transitions.duration.enteringScreen
              : theme.transitions.duration.leavingScreen,
          }),
        },
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          px: 1,
          ...theme.mixins.toolbar,
        }}
      >
        <IconButton
          aria-label="close navigation drawer"
          onClick={onToggle}
          sx={{ visibility: open ? 'visible' : 'hidden' }}
        >
          {theme.direction === 'rtl' ? <ChevronRightIcon /> : <ChevronLeftIcon />}
        </IconButton>
      </Box>
      <Divider />
      <List sx={{ px: open ? 1.5 : 1, py: 2 }}>
        {navItems.map((item) => {
          const Icon = item.icon;
          const selected = activeTab === item.id;
          const button = (
            <ListItem key={item.id} disablePadding sx={{ display: 'block' }}>
              <ListItemButton
                selected={selected}
                onClick={() => onChange(item.id)}
                sx={{
                  mb: 1,
                  minHeight: 52,
                  justifyContent: open ? 'initial' : 'center',
                  borderRadius: 3,
                  px: 2.5,
                  overflow: 'hidden',
                  '&.Mui-selected': {
                    bgcolor: open ? '#eef3ff' : 'transparent',
                    color: 'primary.main',
                    '&:hover': { bgcolor: open ? '#eef3ff' : 'transparent' },
                  },
                }}
              >
                <ListItemIcon
                  sx={{
                    color: selected ? 'primary.main' : 'text.secondary',
                    minWidth: 0,
                    justifyContent: 'center',
                    mr: open ? 3 : 'auto',
                  }}
                >
                  <Icon />
                </ListItemIcon>
                <ListItemText
                  primary={item.label}
                  secondary={item.subtitle}
                  sx={{
                    opacity: open ? 1 : 0,
                    minWidth: 0,
                    transition: (theme) => theme.transitions.create('opacity', {
                      duration: theme.transitions.duration.shortest,
                    }),
                    '& .MuiListItemText-primary, & .MuiListItemText-secondary': {
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                  }}
                />
              </ListItemButton>
            </ListItem>
          );

          return open ? button : (
            <Tooltip key={item.id} title={`${item.label} · ${item.subtitle}`} placement="right">
              {button}
            </Tooltip>
          );
        })}
      </List>
    </Drawer>
  );
}

export { navItems };
