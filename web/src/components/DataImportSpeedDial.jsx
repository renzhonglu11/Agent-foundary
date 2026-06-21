import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  SpeedDial,
  SpeedDialAction,
  SpeedDialIcon,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import CameraAltRoundedIcon from '@mui/icons-material/CameraAltRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import CloudUploadRoundedIcon from '@mui/icons-material/CloudUploadRounded';
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded';
import InsertDriveFileRoundedIcon from '@mui/icons-material/InsertDriveFileRounded';
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded';
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded';
import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded';

const allowedTypes = new Set(['csv', 'pdf']);
const pnlSectionDefinitions = [
  { type: 'expiry', title: '到期收益' },
  { type: 'drawdown', title: '短期情景' },
];
const pnlCurrency = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 2,
});
const pnlPercent = new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const pnlDateTime = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Berlin',
});

function formatBytes(size) {
  if (!Number.isFinite(size)) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function isAllowedFile(file) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  return allowedTypes.has(extension);
}

function formatSignedCurrency(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  const sign = numeric >= 0 ? '+' : '';
  return `${sign}${pnlCurrency.format(numeric)}`;
}

function formatSignedPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  const sign = numeric >= 0 ? '+' : '';
  return `${sign}${pnlPercent.format(numeric)}%`;
}

function pnlColor(value) {
  const numeric = Number(value);
  if (numeric > 0) return 'success.main';
  if (numeric < 0) return 'error.main';
  return 'text.secondary';
}

function formatSnapshotTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return pnlDateTime.format(date);
}

function snapshotFingerprint(records) {
  return JSON.stringify(
    records
      .map((record) => ({
        id: record.id,
        type: record.type,
        productName: record.productName,
        pnl: Number(record.pnl).toFixed(6),
        underlyingMovePct: record.underlyingMovePct == null
          ? null
          : Number(record.underlyingMovePct).toFixed(6),
      }))
      .sort((left, right) => `${left.id}|${left.type}`.localeCompare(`${right.id}|${right.type}`)),
  );
}

export default function DataImportSpeedDial({ pnlRecords = [], onRemovePnlRecord }) {
  const inputRef = useRef(null);
  const [activeDialog, setActiveDialog] = useState(null);
  const [files, setFiles] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [snapshotHistoryOpen, setSnapshotHistoryOpen] = useState(false);
  const [snapshotSaving, setSnapshotSaving] = useState(false);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState('');
  const [snapshotMessage, setSnapshotMessage] = useState('');
  const [snapshots, setSnapshots] = useState([]);
  const [deletingSnapshotId, setDeletingSnapshotId] = useState(null);

  const validFiles = useMemo(() => files.filter(isAllowedFile), [files]);
  const invalidFiles = useMemo(() => files.filter((file) => !isAllowedFile(file)), [files]);
  const importDialogOpen = activeDialog === 'import';
  const pnlSimulatorDialogOpen = activeDialog === 'pnl-simulator';
  const currentSnapshotFingerprint = useMemo(() => snapshotFingerprint(pnlRecords), [pnlRecords]);
  const latestSnapshotFingerprint = useMemo(() => (
    snapshots[0]?.records ? snapshotFingerprint(snapshots[0].records) : null
  ), [snapshots]);
  const currentSnapshotAlreadySaved = Boolean(
    pnlRecords.length && latestSnapshotFingerprint === currentSnapshotFingerprint,
  );

  const loadPnlSnapshots = async () => {
    setSnapshotLoading(true);
    setSnapshotError('');
    try {
      const response = await fetch('/api/pnl-snapshots', { cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || '读取 snapshot 历史失败');
      }
      setSnapshots(Array.isArray(payload?.snapshots) ? payload.snapshots : []);
    } catch (loadError) {
      setSnapshotError(loadError.message || '读取 snapshot 历史失败');
    } finally {
      setSnapshotLoading(false);
    }
  };

  useEffect(() => {
    if (pnlSimulatorDialogOpen || snapshotHistoryOpen) {
      loadPnlSnapshots();
    }
  }, [pnlSimulatorDialogOpen, snapshotHistoryOpen]);

  const closeDialog = () => {
    if (uploading) return;

    setActiveDialog(null);
    if (result?.saved?.length) {
      window.location.reload();
    }
  };

  const addFiles = (fileList) => {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;

    setResult(null);
    setError('');
    setFiles((current) => {
      const map = new Map(current.map((file) => [`${file.name}-${file.size}-${file.lastModified}`, file]));
      incoming.forEach((file) => map.set(`${file.name}-${file.size}-${file.lastModified}`, file));
      return Array.from(map.values());
    });
  };

  const handleUpload = async () => {
    if (!validFiles.length) {
      setError('请先选择至少一个 CSV 或 PDF 文件。');
      return;
    }

    const formData = new FormData();
    validFiles.forEach((file) => formData.append('files', file));

    setUploading(true);
    setError('');
    setResult(null);

    try {
      const response = await fetch('/api/upload-data', {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        const rejectedReason = payload?.rejected
          ?.map((item) => `${item.filename}: ${item.reason}`)
          .join('；');
        throw new Error(rejectedReason || payload?.error || '上传失败');
      }
      setResult(payload);
      setFiles([]);
    } catch (uploadError) {
      setError(uploadError.message || '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const handleCreatePnlSnapshot = async () => {
    if (!pnlRecords.length || snapshotSaving || currentSnapshotAlreadySaved) return;

    setSnapshotSaving(true);
    setSnapshotError('');
    setSnapshotMessage('');
    try {
      const response = await fetch('/api/pnl-snapshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: pnlRecords }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || '保存 snapshot 失败');
      }
      setSnapshots((current) => [payload, ...current.filter((snapshot) => snapshot.id !== payload.id)]);
      setSnapshotMessage(payload.id && snapshots.some((snapshot) => snapshot.id === payload.id)
        ? '当前 Snapshot 已存在'
        : 'Snapshot 已保存');
    } catch (saveError) {
      setSnapshotError(saveError.message || '保存 snapshot 失败');
    } finally {
      setSnapshotSaving(false);
    }
  };

  const handleDeletePnlSnapshot = async (snapshotId) => {
    setDeletingSnapshotId(snapshotId);
    setSnapshotError('');
    setSnapshotMessage('');
    try {
      const response = await fetch(`/api/pnl-snapshots/${encodeURIComponent(snapshotId)}`, {
        method: 'DELETE',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || '删除 snapshot 失败');
      }
      setSnapshots((current) => current.filter((snapshot) => snapshot.id !== snapshotId));
      setSnapshotMessage('Snapshot 已删除');
    } catch (deleteError) {
      setSnapshotError(deleteError.message || '删除 snapshot 失败');
    } finally {
      setDeletingSnapshotId(null);
    }
  };

  return (
    <>
      <SpeedDial
        ariaLabel="dashboard data actions"
        sx={{ position: 'fixed', bottom: 28, right: 28, zIndex: (theme) => theme.zIndex.tooltip }}
        icon={<SpeedDialIcon />}
      >
        <SpeedDialAction
          icon={<CloudUploadRoundedIcon />}
          slotProps={{
            tooltip: {
              title: 'Import 数据文件',
              sx: { whiteSpace: 'nowrap' },
            },
          }}
          onClick={() => setActiveDialog('import')}
        />
        <SpeedDialAction
          icon={<QueryStatsRoundedIcon />}
          slotProps={{
            tooltip: {
              title: 'P&L 模拟器',
              sx: { whiteSpace: 'nowrap' },
            },
          }}
          onClick={() => setActiveDialog('pnl-simulator')}
        />
      </SpeedDial>

      <Dialog open={importDialogOpen} onClose={closeDialog} fullWidth maxWidth="sm">
        <DialogTitle>Import 数据文件</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Typography color="text.secondary">
              支持同时上传多个 dashboard 数据文件（CSV / PDF）。同名文件会覆盖后端 `data` 目录中的旧文件。
            </Typography>

            <Box
              onDragEnter={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                addFiles(event.dataTransfer.files);
              }}
              onClick={() => inputRef.current?.click()}
              sx={{
                border: '1.5px dashed',
                borderColor: dragging ? 'primary.main' : '#cfd8e3',
                bgcolor: dragging ? '#eef3ff' : '#fbfdff',
                borderRadius: 3,
                cursor: 'pointer',
                px: 3,
                py: 4,
                textAlign: 'center',
                transition: '120ms ease',
              }}
            >
              <CloudUploadRoundedIcon color="primary" sx={{ fontSize: 42, mb: 1 }} />
              <Typography fontWeight={800}>把文件拖到这里</Typography>
              <Typography variant="body2" color="text.secondary">或点击选择 CSV / PDF 文件</Typography>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept=".csv,.pdf,text/csv,application/pdf"
                hidden
                onChange={(event) => addFiles(event.target.files)}
              />
            </Box>

            {uploading ? <LinearProgress /> : null}

            {files.length ? (
              <Box>
                <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1 }}>待上传文件</Typography>
                <List dense sx={{ border: '1px solid #e5eaef', borderRadius: 2 }}>
                  {files.map((file) => {
                    const allowed = isAllowedFile(file);
                    return (
                      <ListItem key={`${file.name}-${file.size}-${file.lastModified}`}>
                        <InsertDriveFileRoundedIcon color={allowed ? 'primary' : 'disabled'} sx={{ mr: 1.5 }} />
                        <ListItemText
                          primary={file.name}
                          secondary={allowed ? formatBytes(file.size) : '不支持的文件类型，只允许 CSV / PDF'}
                          slotProps={{ primary: { noWrap: true }, secondary: { color: allowed ? 'text.secondary' : 'error' } }}
                        />
                      </ListItem>
                    );
                  })}
                </List>
              </Box>
            ) : null}

            {invalidFiles.length ? <Alert severity="warning">有 {invalidFiles.length} 个文件会被跳过，仅上传 CSV / PDF。</Alert> : null}
            {error ? <Alert severity="error">{error}</Alert> : null}
            {result?.saved?.length ? (
              <Alert severity="success">
                已上传 {result.saved.length} 个文件：{result.saved.map((item) => item.filename).join('、')}
              </Alert>
            ) : null}

            <Divider />
            <Typography variant="caption" color="text.secondary">
              注意：这个上传入口由后端 `/api/upload-data` 提供；本地开发时 Vite 会把 `/api` 请求代理到后端。
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={uploading} onClick={() => setFiles([])}>清空</Button>
          <Button disabled={uploading} onClick={closeDialog}>关闭</Button>
          <Button variant="contained" disabled={uploading || !validFiles.length} onClick={handleUpload}>
            上传
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={pnlSimulatorDialogOpen} onClose={() => setActiveDialog(null)} fullWidth maxWidth="md">
        <DialogTitle>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="h6" fontWeight={800}>P&L 模拟器</Typography>
            <Tooltip title="历史" arrow>
              <IconButton
                aria-label="显示 snapshot 历史"
                size="small"
                onClick={() => setSnapshotHistoryOpen(true)}
              >
                <HistoryRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            {snapshotMessage ? <Alert severity="success">{snapshotMessage}</Alert> : null}
            {snapshotError ? <Alert severity="error">{snapshotError}</Alert> : null}
            <PnlSimulatorPanel records={pnlRecords} onRemoveRecord={onRemovePnlRecord} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            startIcon={<CameraAltRoundedIcon />}
            variant="contained"
            disabled={snapshotSaving || !pnlRecords.length || currentSnapshotAlreadySaved}
            onClick={handleCreatePnlSnapshot}
          >
            {currentSnapshotAlreadySaved ? '已保存' : 'Snapshot'}
          </Button>
          <Button onClick={() => setActiveDialog(null)}>关闭</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={snapshotHistoryOpen}
        onClose={() => setSnapshotHistoryOpen(false)}
        fullWidth
        maxWidth="md"
        sx={{
          '& .MuiDialog-paper': {
            height: { xs: '88vh', md: '82vh' },
            maxHeight: { xs: '88vh', md: '82vh' },
          },
        }}
      >
        <DialogTitle>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="h6" fontWeight={800}>Snapshot 历史</Typography>
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              <Button size="small" disabled={snapshotLoading} onClick={loadPnlSnapshots}>刷新</Button>
              <IconButton
                aria-label="关闭 snapshot 历史"
                size="small"
                onClick={() => setSnapshotHistoryOpen(false)}
              >
                <CloseRoundedIcon fontSize="small" />
              </IconButton>
            </Stack>
          </Stack>
        </DialogTitle>
        <DialogContent dividers sx={{ minHeight: 0, overflow: 'hidden' }}>
          <PnlSnapshotHistoryPanel
            snapshots={snapshots}
            loading={snapshotLoading}
            error={snapshotError}
            deletingSnapshotId={deletingSnapshotId}
            onDeleteSnapshot={handleDeletePnlSnapshot}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function PnlSnapshotHistoryPanel({ snapshots, loading, error, deletingSnapshotId, onDeleteSnapshot }) {
  const [expandedSnapshotId, setExpandedSnapshotId] = useState(null);

  return (
    <Box
      sx={{
        border: '1px solid #e5eaef',
        borderRadius: 2,
        overflow: 'hidden',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <Stack
        spacing={1.25}
        sx={{
          p: 1.5,
          flex: 1,
          minHeight: 0,
          overflowY: 'scroll',
          overscrollBehavior: 'contain',
          scrollbarWidth: 'thin',
          scrollbarColor: '#b8c4d6 #f5f7fb',
          '&::-webkit-scrollbar': { width: 10 },
          '&::-webkit-scrollbar-track': { backgroundColor: '#f5f7fb' },
          '&::-webkit-scrollbar-thumb': { backgroundColor: '#b8c4d6', borderRadius: 8, border: '2px solid #f5f7fb' },
        }}
      >
        {loading ? <LinearProgress /> : null}
        {error ? <Alert severity="error">{error}</Alert> : null}
        {!loading && !snapshots.length ? (
          <Typography variant="body2" color="text.secondary">暂无 snapshot 记录。</Typography>
        ) : null}
        {snapshots.map((snapshot) => {
          const expanded = expandedSnapshotId === snapshot.id;
          return (
            <Box key={snapshot.id} sx={{ border: '1px solid #e5eaef', borderRadius: 1.5, overflow: 'hidden', flexShrink: 0 }}>
              <Box
                role="button"
                tabIndex={0}
                onClick={() => setExpandedSnapshotId((current) => (current === snapshot.id ? null : snapshot.id))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setExpandedSnapshotId((current) => (current === snapshot.id ? null : snapshot.id));
                  }
                }}
                sx={{
                  px: 1.25,
                  py: 0.85,
                  cursor: 'pointer',
                  backgroundColor: expanded ? '#f8fafc' : '#fbfdff',
                  borderBottom: expanded ? '1px solid #e5eaef' : 0,
                  '&:hover': { backgroundColor: '#f8fafc' },
                }}
              >
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', minWidth: 0 }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.75} sx={{ flex: 1, justifyContent: 'space-between', minWidth: 0 }}>
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0 }}>
                    {expanded ? <KeyboardArrowDownRoundedIcon fontSize="small" /> : <KeyboardArrowRightRoundedIcon fontSize="small" />}
                    <Typography variant="body2" fontWeight={900} noWrap>{formatSnapshotTime(snapshot.createdAt)}</Typography>
                  </Stack>
                  <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                    <Typography variant="caption" color="text.secondary">{snapshot.recordCount} 行</Typography>
                    <Typography variant="caption" fontWeight={800} sx={{ color: pnlColor(snapshot.expiryTotal), fontVariantNumeric: 'tabular-nums' }}>
                      到期 {formatSignedCurrency(snapshot.expiryTotal)}
                    </Typography>
                    <Typography variant="caption" fontWeight={800} sx={{ color: pnlColor(snapshot.drawdownTotal), fontVariantNumeric: 'tabular-nums' }}>
                      短期 {formatSignedCurrency(snapshot.drawdownTotal)}
                    </Typography>
                  </Stack>
                </Stack>
                <IconButton
                  aria-label="删除 snapshot"
                  size="small"
                  disabled={deletingSnapshotId === snapshot.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteSnapshot?.(snapshot.id);
                  }}
                  sx={{ width: 24, height: 24, flexShrink: 0 }}
                >
                  <CloseRoundedIcon fontSize="small" />
                </IconButton>
              </Stack>
            </Box>
              <Collapse in={expanded} timeout="auto" unmountOnExit>
                <PnlSnapshotRecordsSections records={snapshot.records || []} />
              </Collapse>
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}

function PnlSnapshotRecordsSections({ records }) {
  const sections = pnlSectionDefinitions
    .map((definition) => {
      const rows = records.filter((record) => record.type === definition.type);
      const total = rows.reduce((sum, record) => {
        const pnl = Number(record.pnl);
        return Number.isFinite(pnl) ? sum + pnl : sum;
      }, 0);
      return { ...definition, rows, total };
    })
    .filter((section) => section.rows.length);

  if (!sections.length) {
    return (
      <Box sx={{ px: 1.25, py: 1.5 }}>
        <Typography variant="body2" color="text.secondary">这个 snapshot 没有可显示的记录。</Typography>
      </Box>
    );
  }

  return (
    <Stack spacing={1} sx={{ p: 1 }}>
      {sections.map((section) => (
        <Box key={section.type} sx={{ border: '1px solid #edf1f5', borderRadius: 1, overflow: 'hidden' }}>
          <Box sx={{ px: 1, py: 0.6, backgroundColor: '#fbfdff', borderBottom: '1px solid #edf1f5' }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography variant="caption" fontWeight={900}>
                {section.title} · {section.rows.length} 行
              </Typography>
              <Typography variant="caption" fontWeight={900} sx={{ color: pnlColor(section.total), fontVariantNumeric: 'tabular-nums' }}>
                {formatSignedCurrency(section.total)}
              </Typography>
            </Stack>
          </Box>
          <PnlRecordsTable records={section.rows} showDelete={false} />
        </Box>
      ))}
    </Stack>
  );
}

function PnlSimulatorPanel({ records, onRemoveRecord }) {
  const sections = useMemo(() => (
    pnlSectionDefinitions.map((definition) => {
      const rows = records.filter((record) => record.type === definition.type);
      const total = rows.reduce((sum, record) => {
        const pnl = Number(record.pnl);
        return Number.isFinite(pnl) ? sum + pnl : sum;
      }, 0);
      return { ...definition, rows, total };
    })
  ), [records]);

  return (
    <Stack spacing={2}>
      {sections.map((section) => (
        <Box key={section.type} sx={{ border: '1px solid #e5eaef', borderRadius: 2, overflow: 'hidden' }}>
          <Box sx={{ px: 1.5, py: 1, backgroundColor: '#f8fafc', borderBottom: '1px solid #e5eaef' }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography variant="subtitle2" fontWeight={900}>
                {section.title} · {section.rows.length} 行
              </Typography>
              <Typography
                variant="subtitle2"
                fontWeight={900}
                sx={{ color: pnlColor(section.total), fontVariantNumeric: 'tabular-nums' }}
              >
                总收益 {formatSignedCurrency(section.total)}
              </Typography>
            </Stack>
          </Box>

          {section.rows.length ? (
            <PnlRecordsTable records={section.rows} onRemoveRecord={onRemoveRecord} />
          ) : (
            <Box sx={{ px: 1.5, py: 2 }}>
              <Typography variant="body2" color="text.secondary">
                暂无记录。点击对应表格里的收益行后会显示在这里。
              </Typography>
            </Box>
          )}
        </Box>
      ))}
    </Stack>
  );
}

function PnlRecordsTable({ records, onRemoveRecord, showDelete = true }) {
  return (
    <TableContainer>
      <Table size="small" sx={{ tableLayout: 'fixed', minWidth: 640 }}>
        <TableHead>
          <TableRow sx={{ backgroundColor: '#fbfdff' }}>
            {showDelete ? <TableCell width={42} sx={pnlThSx} /> : null}
            <TableCell sx={pnlThSx}>产品名称</TableCell>
            <TableCell width={140} sx={pnlThSx}>标的预估变动</TableCell>
            <TableCell width={140} align="right" sx={pnlThSx}>收益</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {records.map((record, index) => (
            <TableRow key={`${record.id}-${index}`}>
              {showDelete ? (
                <TableCell sx={pnlTdSx}>
                  <IconButton
                    aria-label="删除记录"
                    size="small"
                    onClick={() => onRemoveRecord?.(record.id)}
                    sx={{ width: 24, height: 24 }}
                  >
                    <CloseRoundedIcon fontSize="small" />
                  </IconButton>
                </TableCell>
              ) : null}
              <TableCell sx={pnlTdSx}>
                <Typography variant="body2" fontWeight={700} noWrap title={record.productName}>
                  {record.productName}
                </Typography>
              </TableCell>
              <TableCell sx={pnlTdSx}>
                <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                  {formatSignedPercent(record.underlyingMovePct)}
                </Typography>
              </TableCell>
              <TableCell align="right" sx={pnlTdSx}>
                <Typography
                  variant="body2"
                  fontWeight={800}
                  sx={{ color: pnlColor(record.pnl), fontVariantNumeric: 'tabular-nums' }}
                >
                  {formatSignedCurrency(record.pnl)}
                </Typography>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

const pnlThSx = {
  py: 0.75,
  px: 1,
  fontSize: '0.72rem',
  fontWeight: 800,
  color: 'text.secondary',
  borderBottom: '1px solid #e5eaef',
};

const pnlTdSx = {
  py: 0.75,
  px: 1,
  borderBottom: '1px solid #f0f2f5',
};
