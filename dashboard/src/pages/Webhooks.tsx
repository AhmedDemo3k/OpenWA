import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  Edit,
  Trash2,
  Play,
  ExternalLink,
  Loader2,
  X,
  Webhook as WebhookIcon,
  Check,
  AlertTriangle,
  History,
  Pause,
  Play as ResumeIcon,
  RefreshCw,
  Ban,
} from 'lucide-react';
import { webhookApi, type Webhook, type WebhookDeliveryLog, type WebhookDeadLetter } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import {
  useWebhooksQuery,
  useSessionsQuery,
  useCreateWebhookMutation,
  useUpdateWebhookMutation,
  useDeleteWebhookMutation,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import './Webhooks.css';

const availableEventNames = [
  'message.received',
  'message.sent',
  'message.ack',
  'message.delivered',
  'message.read',
  'message.revoked',
  'session.created',
  'session.deleted',
  'session.status',
  'session.qr',
  'session.authenticated',
  'session.disconnected',
  'group.join',
  'group.leave',
  'group.update',
  '*',
] as const;

export function Webhooks() {
  const { t } = useTranslation();
  useDocumentTitle(t('webhooks.title'));
  const { canWrite } = useRole();
  const { data: webhooks = [], isLoading: loadingWebhooks } = useWebhooksQuery();
  const { data: sessions = [] } = useSessionsQuery();
  const loading = loadingWebhooks;
  const createMutation = useCreateWebhookMutation();
  const updateMutation = useUpdateWebhookMutation();
  const deleteMutation = useDeleteWebhookMutation();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ sessionId: string; id: string; url: string } | null>(null);
  const [editWebhook, setEditWebhook] = useState<Webhook | null>(null);
  const [newWebhook, setNewWebhook] = useState({ url: '', events: ['message.received'], sessionId: '' });
  const [testingId, setTestingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const [logsTarget, setLogsTarget] = useState<Webhook | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryLog[]>([]);
  const [deadLetters, setDeadLetters] = useState<WebhookDeadLetter[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [busyBulk, setBusyBulk] = useState<'retry' | 'remove' | null>(null);
  const [deadLettersUnavailable, setDeadLettersUnavailable] = useState(false);

  const eventDescription = (name: string) => {
    if (name === '*') return t('webhooks.eventDescriptions.all');
    return t(`webhooks.eventDescriptions.${name}`, { defaultValue: name });
  };

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const handleCreate = async () => {
    if (!newWebhook.url || !newWebhook.sessionId) return;
    try {
      await createMutation.mutateAsync({
        sessionId: newWebhook.sessionId,
        url: newWebhook.url,
        events: newWebhook.events,
      });
      setShowCreateModal(false);
      setNewWebhook({ url: '', events: ['message.received'], sessionId: '' });
      setToast({ type: 'success', message: t('webhooks.toasts.created') });
    } catch (err) {
      setToast({
        type: 'error',
        message: t('webhooks.toasts.createFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      });
    }
  };

  const confirmDelete = (sessionId: string, id: string, url: string) => {
    setDeleteTarget({ sessionId, id, url });
    setShowDeleteModal(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync({ sessionId: deleteTarget.sessionId, id: deleteTarget.id });
      setShowDeleteModal(false);
      setDeleteTarget(null);
      setToast({ type: 'success', message: t('webhooks.toasts.deleted') });
    } catch (err) {
      setToast({
        type: 'error',
        message: t('webhooks.toasts.deleteFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      });
    }
  };

  const handleTest = async (sessionId: string, id: string) => {
    setTestingId(id);
    try {
      const result = await webhookApi.test(sessionId, id);
      if (result.success) {
        setToast({ type: 'success', message: t('webhooks.toasts.testOk', { status: result.statusCode }) });
      } else {
        setToast({
          type: 'error',
          message: t('webhooks.toasts.testFailed', { message: result.error || `Status ${result.statusCode}` }),
        });
      }
    } catch (err) {
      setToast({
        type: 'error',
        message: t('webhooks.toasts.testError', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      });
    } finally {
      setTestingId(null);
    }
  };

  const openEdit = (webhook: Webhook) => {
    setEditWebhook({ ...webhook });
    setShowEditModal(true);
  };

  const handleEdit = async () => {
    if (!editWebhook) return;
    try {
      await updateMutation.mutateAsync({
        sessionId: editWebhook.sessionId,
        id: editWebhook.id,
        data: { url: editWebhook.url, events: editWebhook.events, active: editWebhook.active },
      });
      setShowEditModal(false);
      setEditWebhook(null);
      setToast({ type: 'success', message: t('webhooks.toasts.updated') });
    } catch (err) {
      setToast({
        type: 'error',
        message: t('webhooks.toasts.updateFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      });
    }
  };

  const toggleEditEvent = (event: string) => {
    if (!editWebhook) return;
    setEditWebhook({
      ...editWebhook,
      events: editWebhook.events.includes(event)
        ? editWebhook.events.filter(e => e !== event)
        : [...editWebhook.events, event],
    });
  };

  const toggleNewEvent = (event: string) => {
    setNewWebhook(prev => ({
      ...prev,
      events: prev.events.includes(event) ? prev.events.filter(e => e !== event) : [...prev.events, event],
    }));
  };

  const openLogs = async (webhook: Webhook) => {
    setLogsTarget(webhook);
    setDeliveries([]);
    setDeadLetters([]);
    setDeadLettersUnavailable(false);
    setLoadingLogs(true);
    try {
      const deliveriesRes = await webhookApi.deliver(webhook.sessionId, webhook.id, 50);
      setDeliveries(deliveriesRes);
    } catch (err) {
      setToast({
        type: 'error',
        message: t('webhooks.toasts.logsFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      });
    }
    try {
      const deadRes = await webhookApi.listDeadLetters(webhook.sessionId, webhook.id, 50);
      setDeadLetters(deadRes);
    } catch {
      // Dead-letter listing requires the BullMQ queue. When it is disabled we still
      // show the deliveries that are available and surface a note instead of failing.
      setDeadLetters([]);
      setDeadLettersUnavailable(true);
    }
    setLoadingLogs(false);
  };

  const handleRetryJob = async (jobId: string) => {
    if (!logsTarget) return;
    setBusyJobId(jobId);
    try {
      await webhookApi.retryDeadLetter(logsTarget.sessionId, logsTarget.id, jobId);
      setDeadLetters(prev => prev.filter(d => d.jobId !== jobId));
      setToast({ type: 'success', message: t('webhooks.toasts.retried') });
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('common.unknownError'),
      });
    } finally {
      setBusyJobId(null);
    }
  };

  const handleRemoveJob = async (jobId: string) => {
    if (!logsTarget) return;
    setBusyJobId(jobId);
    try {
      await webhookApi.removeDeadLetter(logsTarget.sessionId, logsTarget.id, jobId);
      setDeadLetters(prev => prev.filter(d => d.jobId !== jobId));
      setToast({ type: 'success', message: t('webhooks.toasts.removed') });
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('common.unknownError'),
      });
    } finally {
      setBusyJobId(null);
    }
  };

  const handleRetryAll = async () => {
    if (!logsTarget) return;
    setBusyBulk('retry');
    try {
      const res = await webhookApi.retryAllDeadLetters(logsTarget.sessionId, logsTarget.id);
      const loaded = await webhookApi.listDeadLetters(logsTarget.sessionId, logsTarget.id, 50);
      setDeadLetters(loaded);
      setToast({
        type: 'success',
        message: t('webhooks.toasts.retriedAll', { retried: res.retried }),
      });
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('common.unknownError'),
      });
    } finally {
      setBusyBulk(null);
    }
  };

  const handleRemoveAll = async () => {
    if (!logsTarget) return;
    setBusyBulk('remove');
    try {
      await webhookApi.removeAllDeadLetters(logsTarget.sessionId, logsTarget.id);
      setDeadLetters([]);
      setToast({ type: 'success', message: t('webhooks.toasts.removedAll') });
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('common.unknownError'),
      });
    } finally {
      setBusyBulk(null);
    }
  };

  const togglePause = async (webhook: Webhook) => {
    try {
      await updateMutation.mutateAsync({
        sessionId: webhook.sessionId,
        id: webhook.id,
        data: { paused: !webhook.paused },
      });
      setToast({
        type: 'success',
        message: t(webhook.paused ? 'webhooks.toasts.resumed' : 'webhooks.toasts.paused'),
      });
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('common.unknownError'),
      });
    }
  };

  if (loading) {
    return (
      <div
        className="webhooks-page"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="webhooks-page">
      {toast && (
        <div className={`toast ${toast.type}`}>
          {toast.type === 'success' ? <Check size={18} /> : <AlertTriangle size={18} />}
          <span>{toast.message}</span>
          <button className="toast-close" onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}

      <PageHeader
        title={t('webhooks.title')}
        subtitle={t('webhooks.subtitle')}
        actions={
          canWrite && (
            <button className="btn-primary" onClick={() => setShowCreateModal(true)}>
              <Plus size={18} />
              {t('webhooks.addWebhook')}
            </button>
          )
        }
      />

      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('webhooks.createTitle')}</h2>
              <button className="btn-icon" onClick={() => setShowCreateModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <label>{t('webhooks.session')}</label>
              <select
                value={newWebhook.sessionId}
                onChange={e => setNewWebhook({ ...newWebhook, sessionId: e.target.value })}
              >
                <option value="">{t('webhooks.selectSession')}</option>
                {sessions.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <label>{t('common.url')}</label>
              <input
                type="url"
                placeholder="https://..."
                value={newWebhook.url}
                onChange={e => setNewWebhook({ ...newWebhook, url: e.target.value })}
              />
              <label>{t('webhooks.events')}</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {availableEventNames.map(name => (
                  <button
                    key={name}
                    type="button"
                    className={`event-tag ${newWebhook.events.includes(name) ? 'selected' : ''}`}
                    onClick={() => toggleNewEvent(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowCreateModal(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={handleCreate}>
                {t('common.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showEditModal && editWebhook && (
        <div className="modal-overlay" onClick={() => setShowEditModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('webhooks.editTitle')}</h2>
              <button className="btn-icon" onClick={() => setShowEditModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <label>{t('common.url')}</label>
              <input
                type="url"
                value={editWebhook.url}
                onChange={e => setEditWebhook({ ...editWebhook, url: e.target.value })}
              />
              <label>{t('webhooks.events')}</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {availableEventNames.map(name => (
                  <button
                    key={name}
                    type="button"
                    className={`event-tag ${editWebhook.events.includes(name) ? 'selected' : ''}`}
                    onClick={() => toggleEditEvent(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
              <div className="toggle-group">
                <span className="toggle-label">{t('common.status')}</span>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={editWebhook.active}
                    onChange={e => setEditWebhook({ ...editWebhook, active: e.target.checked })}
                  />
                  <span className="toggle-slider"></span>
                </label>
                <span className={`toggle-status ${editWebhook.active ? 'active' : 'inactive'}`}>
                  {editWebhook.active ? t('common.active') : t('common.inactive')}
                </span>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowEditModal(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={handleEdit}>
                {t('webhooks.saveChanges')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteModal && deleteTarget && (
        <div className="modal-overlay" onClick={() => setShowDeleteModal(false)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('webhooks.deleteTitle')}</h2>
              <button className="btn-icon" onClick={() => setShowDeleteModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <p>{t('webhooks.deleteConfirm')}</p>
              <code
                style={{
                  display: 'block',
                  marginTop: '0.5rem',
                  padding: '0.5rem',
                  background: 'var(--color-bg-secondary)',
                  borderRadius: '4px',
                  fontSize: '0.85rem',
                  wordBreak: 'break-all',
                }}
              >
                {deleteTarget.url}
              </code>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowDeleteModal(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={handleDelete}>
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="webhooks-content">
        <div className="webhooks-table-container">
          <div className="webhooks-table">
            <div className="table-row header">
              <span>{t('webhooks.columns.url')}</span>
              <span>{t('webhooks.columns.events')}</span>
              <span>{t('webhooks.columns.session')}</span>
              <span>{t('webhooks.columns.status')}</span>
              <span>{t('webhooks.columns.actions')}</span>
            </div>
            {webhooks.length === 0 ? (
              <div className="empty-table-state">
                <WebhookIcon size={48} strokeWidth={1} />
                <h3>{t('webhooks.empty.title')}</h3>
                <p>{t('webhooks.empty.description')}</p>
              </div>
            ) : (
              webhooks.map(webhook => (
                <div key={webhook.id} className="table-row">
                  <span className="url-cell">
                    <code>{webhook.url}</code>
                    <ExternalLink size={14} />
                  </span>
                  <span className="events-cell">
                    {webhook.events.map((event: string) => (
                      <span key={event} className="event-tag">
                        {event}
                      </span>
                    ))}
                  </span>
                  <span>
                    {sessions.find(s => s.id === webhook.sessionId)?.name || webhook.sessionId.substring(0, 8)}
                  </span>
                  <span className="status-cell">
                    {webhook.paused ? (
                      <span className="status-badge paused" title={webhook.pauseReason || ''}>
                        <Pause size={12} />
                        {t('webhooks.status.paused')}
                      </span>
                    ) : (
                      <span className={`status-badge ${webhook.active ? 'active' : 'inactive'}`}>
                        {webhook.active ? t('common.active') : t('common.inactive')}
                      </span>
                    )}
                    {webhook.lastStatusCode != null && (
                      <span
                        className={`health-dot ${webhook.lastStatusCode >= 200 && webhook.lastStatusCode < 300 ? 'ok' : 'fail'}`}
                        title={`${webhook.lastStatusCode}${webhook.lastError ? ` — ${webhook.lastError}` : ''}`}
                      />
                    )}
                    {(webhook.consecutiveFailures ?? 0) > 0 && (
                      <span className="fail-count" title={`${webhook.consecutiveFailures} ${t('webhooks.status.failures')}`}>
                        {webhook.consecutiveFailures}×
                      </span>
                    )}
                  </span>
                  <span className="actions-cell">
                    <button
                      className="icon-btn"
                      title={t('webhooks.actions.test')}
                      onClick={() => handleTest(webhook.sessionId, webhook.id)}
                      disabled={testingId === webhook.id}
                    >
                      {testingId === webhook.id ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                    </button>
                    <button
                      className="icon-btn"
                      title={t('webhooks.actions.logs')}
                      onClick={() => void openLogs(webhook)}
                    >
                      <History size={16} />
                    </button>
                    {canWrite && (
                      <>
                        {webhook.paused && (
                          <button
                            className="icon-btn"
                            title={t('webhooks.actions.resume')}
                            onClick={() => void togglePause(webhook)}
                          >
                            <ResumeIcon size={16} />
                          </button>
                        )}
                        <button className="icon-btn" title={t('webhooks.actions.edit')} onClick={() => openEdit(webhook)}>
                          <Edit size={16} />
                        </button>
                        <button
                          className="icon-btn danger"
                          title={t('webhooks.actions.delete')}
                          onClick={() => confirmDelete(webhook.sessionId, webhook.id, webhook.url)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="events-reference">
          <h3>{t('webhooks.available')}</h3>
          <div className="events-list">
            {availableEventNames.map(name => (
              <div key={name} className="event-item">
                <code>{name}</code>
                <span>{eventDescription(name)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {logsTarget && (
        <div className="modal-overlay" onClick={() => setLogsTarget(null)}>
          <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>
                {t('webhooks.deliveriesTitle')}
                <code className="deliveries-url">{logsTarget.url}</code>
              </h2>
              <button className="btn-icon" onClick={() => setLogsTarget(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              {loadingLogs ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
                  <Loader2 size={28} className="animate-spin" />
                </div>
              ) : (
                <>
                  <div className="deliveries-section-header">
                    <h3>{t('webhooks.deliveries.recent')}</h3>
                  </div>
                  {deliveries.length === 0 ? (
                    <p className="deliveries-empty">{t('webhooks.deliveries.empty')}</p>
                  ) : (
                    <div className="deliveries-table">
                      <div className="table-row header">
                        <span>{t('webhooks.columns.result')}</span>
                        <span>{t('webhooks.columns.status')}</span>
                        <span>{t('webhooks.columns.event')}</span>
                        <span>{t('webhooks.columns.duration')}</span>
                        <span>{t('webhooks.columns.attempt')}</span>
                        <span>{t('webhooks.columns.time')}</span>
                      </div>
                      {deliveries.map(d => (
                        <div key={d.id} className="table-row">
                          <span className={`status-badge ${d.success ? 'active' : 'failed'}`}>
                            {d.success ? t('common.success') : t('common.failed')}
                          </span>
                          <span>{d.statusCode ?? '—'}</span>
                          <span>
                            <code className="delivery-event">{d.event}</code>
                          </span>
                          <span>{d.responseTimeMs != null ? `${d.responseTimeMs}ms` : '—'}</span>
                          <span>{d.attempt ?? '—'}</span>
                          <span>{d.createdAt ? new Date(d.createdAt).toLocaleString() : '—'}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="deliveries-section-header">
                    <h3>{t('webhooks.deliveries.deadLetters')}</h3>
                    {deadLetters.length > 0 && canWrite && (
                      <span className="deliveries-bulk-actions">
                        <button
                          className="btn-secondary btn-sm"
                          disabled={busyBulk === 'retry'}
                          onClick={() => void handleRetryAll()}
                        >
                          {busyBulk === 'retry' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                          {t('webhooks.actions.retryAll')}
                        </button>
                        <button
                          className="btn-secondary btn-sm danger-text"
                          disabled={busyBulk === 'remove'}
                          onClick={() => void handleRemoveAll()}
                        >
                          {busyBulk === 'remove' ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />}
                          {t('webhooks.actions.removeAll')}
                        </button>
                      </span>
                    )}
                  </div>
                  {deadLetters.length === 0 ? (
                    <p className="deliveries-empty">
                      {deadLettersUnavailable
                        ? t('webhooks.deliveries.queueDisabled')
                        : t('webhooks.deliveries.noDeadLetters')}
                    </p>
                  ) : (
                    <div className="deliveries-table">
                      <div className="table-row header">
                        <span>{t('webhooks.columns.event')}</span>
                        <span>{t('webhooks.columns.attempt')}</span>
                        <span>{t('webhooks.columns.reason')}</span>
                        <span>{t('webhooks.columns.time')}</span>
                        <span>{t('webhooks.columns.actions')}</span>
                      </div>
                      {deadLetters.map(d => (
                        <div key={d.jobId} className="table-row">
                          <span>
                            <code className="delivery-event">{d.event}</code>
                          </span>
                          <span>{d.attemptsMade}</span>
                          <span className="delivery-failure-reason" title={d.failedReason}>
                            {d.failedReason || '—'}
                          </span>
                          <span>{d.timestamp ? new Date(d.timestamp).toLocaleString() : '—'}</span>
                          <span className="actions-cell">
                            {canWrite && (
                              <>
                                <button
                                  className="icon-btn"
                                  title={t('webhooks.actions.retry')}
                                  disabled={busyJobId === d.jobId}
                                  onClick={() => void handleRetryJob(d.jobId)}
                                >
                                  {busyJobId === d.jobId ? (
                                    <Loader2 size={16} className="animate-spin" />
                                  ) : (
                                    <RefreshCw size={16} />
                                  )}
                                </button>
                                <button
                                  className="icon-btn danger"
                                  title={t('webhooks.actions.remove')}
                                  disabled={busyJobId === d.jobId}
                                  onClick={() => void handleRemoveJob(d.jobId)}
                                >
                                  <Ban size={16} />
                                </button>
                              </>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
