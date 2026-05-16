import { useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  SpeedDial,
  SpeedDialAction,
  SpeedDialIcon,
  Stack,
  Typography,
} from '@mui/material';
import CloudUploadRoundedIcon from '@mui/icons-material/CloudUploadRounded';
import InsertDriveFileRoundedIcon from '@mui/icons-material/InsertDriveFileRounded';

const allowedTypes = new Set(['csv', 'pdf']);

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

export default function DataImportSpeedDial() {
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const validFiles = useMemo(() => files.filter(isAllowedFile), [files]);
  const invalidFiles = useMemo(() => files.filter((file) => !isAllowedFile(file)), [files]);

  const closeDialog = () => {
    if (uploading) return;

    setOpen(false);
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
        throw new Error(payload?.error || rejectedReason || '上传失败');
      }
      setResult(payload);
      setFiles([]);
    } catch (uploadError) {
      setError(uploadError.message || '上传失败');
    } finally {
      setUploading(false);
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
              open: true,
            },
          }}
          onClick={() => setOpen(true)}
        />
      </SpeedDial>

      <Dialog open={open} onClose={closeDialog} fullWidth maxWidth="sm">
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
    </>
  );
}
