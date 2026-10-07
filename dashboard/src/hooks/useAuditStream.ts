import { useEffect, useRef, useState } from 'react';
import type { AuditLog } from '../services/api';

interface UseAuditStreamResult {
  entries: AuditLog[];
  connected: boolean;
  clear: () => void;
}

const MAX_LIVE_ENTRIES = 200;

/**
 * Consumes the `/api/audit/stream` Server-Sent Events feed using fetch() so the
 * X-API-Key header can be sent (EventSource cannot set headers). Exposes the newest
 * entries plus a connected flag driven by the stream's live status.
 */
export function useAuditStream(enabled: boolean): UseAuditStreamResult {
  const [entries, setEntries] = useState<AuditLog[]>([]);
  const [connected, setConnected] = useState(false);
  const latestRef = useRef<AuditLog[]>([]);

  const pushEntry = (log: AuditLog) => {
    if (!log?.id || typeof log !== 'object') return;
    const deduped = latestRef.current.filter(existing => existing.id !== log.id);
    latestRef.current = [log, ...deduped].slice(0, MAX_LIVE_ENTRIES);
    setEntries(latestRef.current);
  };

  const clear = () => {
    latestRef.current = [];
    setEntries([]);
  };

  useEffect(() => {
    if (!enabled) {
      latestRef.current = [];
      setEntries([]);
      setConnected(false);
      return;
    }

    const apiKey = sessionStorage.getItem('openwa_api_key');
    const controller = new AbortController();
    let closed = false;

    const parseBlock = (block: string) => {
      const data = block
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n');
      if (!data) return;
      try {
        const parsed = JSON.parse(data) as unknown;
        if (parsed && typeof parsed === 'object') {
          pushEntry(parsed as AuditLog);
        }
      } catch {
        // Heartbeat and malformed frames carry no usable `data`; ignore them.
      }
    };

    const connect = async (): Promise<void> => {
      try {
        const response = await fetch('/api/audit/stream', {
          headers: apiKey ? { 'X-API-Key': apiKey } : undefined,
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`Live log stream failed with status ${response.status}`);
        }
        setConnected(true);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        let reading = true;
        while (reading) {
          const { value, done } = await reader.read();
          reading = !done;
          if (value && value.byteLength > 0) {
            buffer += decoder.decode(value, { stream: true });
          }
          let separator = buffer.indexOf('\n\n');
          while (separator !== -1) {
            const block = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            parseBlock(block);
            separator = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        if (closed) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setConnected(false);
        return;
      }
      if (!closed) setConnected(false);
    };

    void connect();

    return () => {
      closed = true;
      controller.abort();
    };
  }, [enabled]);

  return { entries, connected, clear };
}