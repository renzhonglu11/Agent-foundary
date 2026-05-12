import { Fragment } from 'react';
import { Box, Card, CardContent, Chip, Divider, List, ListItem, Stack, Typography, useTheme } from '@mui/material';
import { date, preciseCurrency, pnlColor } from '../utils/formatters.js';

export default function RecentActivity({ transactions }) {
  const theme = useTheme();
  return (
    <Card className="panel-card">
      <CardContent>
        <Typography variant="h6" mb={1}>最近交易</Typography>
        <List disablePadding>
          {transactions.slice(0, 10).map((tx, index) => (
            <Fragment key={`${tx.date}-${tx.type}-${tx.name}-${index}`}>
              <ListItem disableGutters sx={{ alignItems: 'flex-start' }}>
                <Box sx={{ width: '100%', minWidth: 0 }}>
                  <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between' }}>
                    <Typography fontWeight={700} noWrap>{tx.name}</Typography>
                    <Typography fontWeight={800} color={pnlColor(tx.amount, theme)}>{preciseCurrency.format(tx.amount)}</Typography>
                  </Stack>
                  <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 0.75, flexWrap: 'wrap' }}>
                    <Chip size="small" label={date(tx.date)} />
                    <Chip size="small" variant="outlined" label={tx.type} />
                    <Chip size="small" variant="outlined" label={tx.assetClass} />
                    {tx.symbol && <Chip size="small" color="primary" variant="outlined" label={tx.symbol} />}
                  </Stack>
                </Box>
              </ListItem>
              {index < transactions.length - 1 && <Divider component="li" />}
            </Fragment>
          ))}
        </List>
      </CardContent>
    </Card>
  );
}
