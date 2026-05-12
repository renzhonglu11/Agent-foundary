import { useEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';

export default function MeasuredChart({ children, minHeight = 240, fallback = '图表尺寸初始化中...' }) {
  const ref = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!ref.current) return undefined;

    const updateSize = () => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);
      if (width > 0 && height > 0) {
        setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  const ready = size.width > 0 && size.height > 0;

  return (
    <Box ref={ref} sx={{ width: '100%', height: '100%', minHeight, minWidth: 0 }}>
      {ready ? children(size) : (
        <Box sx={{ height: '100%', display: 'grid', placeItems: 'center', color: 'text.secondary' }}>
          <Typography variant="body2">{fallback}</Typography>
        </Box>
      )}
    </Box>
  );
}
