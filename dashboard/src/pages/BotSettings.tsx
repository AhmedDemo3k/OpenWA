import { useState, useEffect, type Dispatch, type SetStateAction } from 'react';
import { Settings2, Sparkles, FileCode, Download, Upload, Keyboard, Database, Loader2, Search, CheckSquare, Square, type LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast';
import './BotSettings.css';

type ToastApi = ReturnType<typeof useToast>;

interface TabCommonProps {
  t: TFunction;
  toast: ToastApi;
}

interface ExtractStatus {
  messagesExtracted?: number;
  chatsWithData?: number;
  pairsGenerated?: number;
  error?: string;
}

interface ChatHistory {
  exists?: boolean;
  size: number;
  lines: number;
  preview?: string;
}

interface BotConfig {
  gemini?: { hasKey?: boolean; model?: string };
  openai?: { hasKey?: boolean; model?: string };
  activeProvider?: string;
  features?: Record<string, boolean>;
}

interface BotStats {
  features?: Record<string, boolean>;
  uptime?: string;
  totalReplies?: number;
  totalChats?: number;
  model?: string;
}

interface ConfigPatchBody {
  activeProvider?: string;
  gemini?: { model?: string; apiKey?: string };
  openai?: { model?: string; apiKey?: string };
  features?: Record<string, boolean>;
}

interface ScrapeBody {
  sessionId?: string;
  chatIds?: string[];
}

interface ExtractTabProps extends TabCommonProps {
  extractStatus: ExtractStatus | null;
  setExtractStatus: Dispatch<SetStateAction<ExtractStatus | null>>;
  uploadText: string;
  setUploadText: Dispatch<SetStateAction<string>>;
  chatHistory: ChatHistory | null;
  setChatHistory: Dispatch<SetStateAction<ChatHistory | null>>;
}

interface StyleFingerprint {
  formality?: string;
  avgMessageWords?: number;
  avgResponseLength?: number;
  emojiUsage?: { usage?: string; avgPerMessage?: number };
  languageMix?: { dominant?: string; arabicPercent?: number; englishPercent?: number };
  messagesAnalyzed?: number;
  totalConversations?: number;
  punctuation?: { dominant?: string; period?: number; exclamation?: number; question?: number };
  commonGreetings?: string[];
  commonSignoffs?: string[];
  topPhrases?: { phrase: string; count: number }[];
  responseStyle?: string;
}

interface StyleData {
  fingerprint?: StyleFingerprint;
  hasData?: boolean;
  systemPrompt?: string;
  overrides?: { formality?: string; responseLength?: string; emojiUsage?: string; customInstructions?: string };
}

interface RuleItem {
  id: string;
  trigger: string;
  response: string;
  context?: string;
  enabled?: boolean;
}

interface KeywordItem {
  id: string;
  keywords?: string[];
  reply: string;
  context?: string;
  enabled?: boolean;
}

interface MemoryEntry {
  chatId?: string;
  id?: string;
  memory?: string;
  data?: string;
}

const tabs: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'general', label: 'botSettings.tabs.general', icon: Settings2 },
  { id: 'style', label: 'botSettings.tabs.style', icon: Sparkles },
  { id: 'rules', label: 'botSettings.tabs.rules', icon: FileCode },
  { id: 'extract', label: 'botSettings.tabs.extract', icon: Download },
  { id: 'keywords', label: 'botSettings.tabs.keywords', icon: Keyboard },
  { id: 'memory', label: 'botSettings.tabs.memory', icon: Database },
];

type TabId = 'general' | 'style' | 'rules' | 'extract' | 'keywords' | 'memory';

export default function BotSettings() {
  const { t } = useTranslation();
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [extractStatus, setExtractStatus] = useState<ExtractStatus | null>(null);
  const [uploadText, setUploadText] = useState('');
  const [chatHistory, setChatHistory] = useState<ChatHistory | null>(null);

  useEffect(() => {
    fetch('/bot-api/api/chat-history').then(r => r.json()).then(setChatHistory).catch(() => {});
  }, []);

  return (
    <div className="bot-settings">
      <div className="settings-header">
        <h2 className="settings-title">{t('botSettings.title')}</h2>
      </div>

      <div className="settings-tabs">
        {tabs.map(tab => (
          <button key={tab.id} className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`} onClick={() => setActiveTab(tab.id)}>
            <tab.icon size={16} />
            <span>{t(tab.label)}</span>
          </button>
        ))}
      </div>

      <div className="tab-content">
        {activeTab === 'general' && <GeneralTab t={t} toast={toast} />}
        {activeTab === 'style' && <StyleTab t={t} extractStatus={extractStatus} toast={toast} />}
        {activeTab === 'rules' && <RulesTab t={t} toast={toast} />}
        {activeTab === 'extract' && <ExtractTab extractStatus={extractStatus} setExtractStatus={setExtractStatus} uploadText={uploadText} setUploadText={setUploadText} chatHistory={chatHistory} setChatHistory={setChatHistory} t={t} toast={toast} />}
        {activeTab === 'keywords' && <KeywordsTab t={t} toast={toast} />}
        {activeTab === 'memory' && <MemoryTab t={t} toast={toast} />}
      </div>
    </div>
  );
}

// â•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گ GENERAL TAB â•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گ
function GeneralTab({ t, toast }: TabCommonProps) {
  const [stats, setStats] = useState<BotStats | null>(null);
  const [config, setConfig] = useState<BotConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [geminiKey, setGeminiKey] = useState('');
  const [geminiModel, setGeminiModel] = useState('gemini-2.0-flash');
  const [openaiKey, setOpenaiKey] = useState('');
  const [openaiModel, setOpenaiModel] = useState('gpt-4o-mini');
  const [activeProvider, setActiveProvider] = useState('gemini');
  const [saving, setSaving] = useState(false);

  const loadData = () => {
    Promise.all([
      fetch('/bot-api/api/stats').then(r => r.json()),
      fetch('/bot-api/api/config').then(r => r.json()),
    ]).then(([s, c]) => {
      setStats(s); setConfig(c);
      setGeminiModel(c.gemini?.model || 'gemini-2.0-flash');
      setOpenaiModel(c.openai?.model || 'gpt-4o-mini');
      setActiveProvider(c.activeProvider || 'gemini');
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(loadData, []);

  const toggleFeature = async (feature: string, enabled: boolean) => {
    try {
      await fetch('/bot-api/api/config', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features: { [feature]: enabled } }),
      });
      toast.success(t('botSettings.general.saved'), '');
    } catch { toast.error(t('botSettings.general.error'), ''); }
  };

  const saveApiKeys = async () => {
    setSaving(true);
    try {
      const body: ConfigPatchBody = { activeProvider };
      body.gemini = { model: geminiModel };
      if (geminiKey) body.gemini = { ...body.gemini, apiKey: geminiKey };
      body.openai = { model: openaiModel };
      if (openaiKey) body.openai = { ...body.openai, apiKey: openaiKey };
      await fetch('/bot-api/api/config', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      toast.success(t('botSettings.general.configSaved'), '');
      setGeminiKey(''); setOpenaiKey('');
      loadData();
    } catch { toast.error(t('botSettings.general.configError'), ''); }
    setSaving(false);
  };

  if (loading) return <div className="loading">{t('botSettings.loading')}</div>;

  return (
    <>
      <div className="tab-section">
        <h3 className="section-title">{t('botSettings.general.sectionApiKeys')}</h3>
        <div className="api-keys-grid">
          <div className="api-key-card">
            <h4>Gemini</h4>
            <div className="form-field">
              <label>{t('botSettings.general.apiKey')}</label>
              <input
                type="password" placeholder={config?.gemini?.hasKey ? 'â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢' + ' (leave blank to keep)' : 'Enter Gemini API key'}
                value={geminiKey} onChange={e => setGeminiKey(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label>{t('botSettings.general.model')}</label>
              <select value={geminiModel} onChange={e => setGeminiModel(e.target.value)}>
                <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                <option value="gemini-2.0-flash-lite">Gemini 2.0 Flash Lite</option>
              </select>
            </div>
            {config?.gemini?.hasKey && !geminiKey && <span className="key-status active">{t('botSettings.general.keyActive')}</span>}
          </div>
          <div className="api-key-card">
            <h4>ChatGPT</h4>
            <div className="form-field">
              <label>{t('botSettings.general.apiKey')}</label>
              <input
                type="password" placeholder={config?.openai?.hasKey ? 'â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢' + ' (leave blank to keep)' : 'Enter OpenAI API key'}
                value={openaiKey} onChange={e => setOpenaiKey(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label>{t('botSettings.general.model')}</label>
              <select value={openaiModel} onChange={e => setOpenaiModel(e.target.value)}>
                <option value="gpt-4o">GPT-4o</option>
                <option value="gpt-4o-mini">GPT-4o Mini</option>
                <option value="gpt-4-turbo">GPT-4 Turbo</option>
              </select>
            </div>
            {config?.openai?.hasKey && !openaiKey && <span className="key-status active">{t('botSettings.general.keyActive')}</span>}
          </div>
        </div>
        <div className="form-field">
          <label>{t('botSettings.general.activeProvider')}</label>
          <select value={activeProvider} onChange={e => setActiveProvider(e.target.value)}>
            <option value="gemini">Gemini</option>
            <option value="openai">ChatGPT</option>
          </select>
        </div>
        <button className="btn-primary" onClick={saveApiKeys} disabled={saving} style={{ marginTop: '1rem' }}>
          {saving ? <Loader2 className="animate-spin" size={16} /> : t('botSettings.general.saveConfig')}
        </button>
      </div>

      <div className="tab-section">
        <h3 className="section-title">{t('botSettings.general.sectionFeatures')}</h3>
        <div className="features-grid">
          {[
            { key: 'style', label: t('botSettings.general.styleEnabled') },
            { key: 'fewShot', label: t('botSettings.general.fewShotEnabled') },
            { key: 'rules', label: t('botSettings.general.rulesEnabled') },
            { key: 'memory', label: t('botSettings.general.memoryEnabled') },
            { key: 'keywordReplies', label: t('botSettings.general.keywordsEnabled') },
            { key: 'scheduling', label: t('botSettings.general.featureSchedule') },
          ].map(f => (
            <label key={f.key} className="feature-toggle">
              <input type="checkbox" checked={!!stats?.features?.[f.key]} onChange={e => toggleFeature(f.key, e.target.checked)} />
              <span>{f.label}</span>
            </label>
          ))}
        </div>
      </div>

      {stats && (
        <div className="tab-section">
          <h3 className="section-title">{t('botSettings.general.stats')}</h3>
          <div className="stats-grid">
            <div className="stat-item"><span>{t('botSettings.general.uptime')}</span><strong>{stats.uptime || 'N/A'}</strong></div>
            <div className="stat-item"><span>{t('botSettings.general.totalReplies')}</span><strong>{stats.totalReplies || 0}</strong></div>
            <div className="stat-item"><span>{t('botSettings.general.totalChats')}</span><strong>{stats.totalChats || 0}</strong></div>
            <div className="stat-item"><span>{t('botSettings.general.model')}</span><strong>{stats.model || 'N/A'}</strong></div>
          </div>
        </div>
      )}
    </>
  );
}

// â•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گ EXTRACT TAB â•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گ

interface ChatInfo {
  id: string;
  name: string;
  isGroup: boolean;
  hasUnread: boolean;
  lastMessage: string;
}

interface SessionInfo {
  id: string;
  dir: string;
  port: number | null;
}

function ExtractTab({ extractStatus, setExtractStatus, uploadText, setUploadText, chatHistory, setChatHistory, t, toast }: ExtractTabProps) {
  const [scraping, setScraping] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedSession, setSelectedSession] = useState<string>('');
  const [chats, setChats] = useState<ChatInfo[]>([]);
  const [selectedChatIds, setSelectedChatIds] = useState<Set<string>>(new Set());
  const [loadingChats, setLoadingChats] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    fetch('/bot-api/api/sessions').then(r => r.json()).then((s: SessionInfo[]) => {
      setSessions(s);
      if (s.length > 0) setSelectedSession(s[0].id);
    }).catch(() => {});
  }, []);

  const loadChats = async (sessionId: string) => {
    if (!sessionId) return;
    setLoadingChats(true);
    setChats([]);
    setSelectedChatIds(new Set());
    try {
      const res = await fetch(`/bot-api/api/sessions/${sessionId}/chats`);
      const data = await res.json();
      if (Array.isArray(data)) setChats(data);
    } catch { /* ignore network errors */ }
    setLoadingChats(false);
  };

  useEffect(() => {
    if (selectedSession) loadChats(selectedSession);
  }, [selectedSession]);

  const toggleChat = (id: string) => {
    setSelectedChatIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedChatIds(new Set(chats.map(c => c.id)));
  };

  const deselectAll = () => {
    setSelectedChatIds(new Set());
  };

  const handleScrape = async () => {
    setScraping(true);
    try {
      const body: ScrapeBody = {};
      if (selectedSession) body.sessionId = selectedSession;
      if (selectedChatIds.size > 0) body.chatIds = Array.from(selectedChatIds);

      const res = await fetch('/bot-api/api/chats/scrape', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(r => r.json());

      if (res.messagesExtracted) {
        toast.success(t('botSettings.extract.extractSuccess'), `${res.chatsWithData} chats, ${res.messagesExtracted} messages, ${res.pairsGenerated} pairs`);
        setChatHistory(await fetch('/bot-api/api/chat-history').then(r => r.json()));
        setExtractStatus(res);
      } else {
        toast.error(res.error || t('botSettings.extract.extractError'), '');
      }
    } catch { toast.error(t('botSettings.extract.extractError'), ''); }
    setScraping(false);
  };

  const handleClean = async () => {
    if (!uploadText.trim()) return;
    setCleaning(true);
    try {
      const res = await fetch('/bot-api/api/clean', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText: uploadText }),
      }).then(r => r.json());
      if (res.pairsFound > 0) {
        toast.success(t('botSettings.extract.cleanSuccess'), `${res.pairsFound} pairs`);
        setChatHistory(await fetch('/bot-api/api/chat-history').then(r => r.json()));
      } else {
        const msg = (res.error || '') + (res.hint ? ' ' + res.hint : '');
        toast.error(res.error || t('botSettings.extract.cleanError'), msg);
      }
    } catch { toast.error(t('botSettings.extract.cleanError'), ''); }
    setCleaning(false);
  };

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setUploadText(await file.text());
  };

  const filteredChats = chats.filter(c => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q);
  });

  return (
    <>
      {/* Session Selection */}
      <div className="tab-section">
        <h3 className="section-title">{t('botSettings.extract.sectionExtract')}</h3>
        <div className="session-selector">
          <label>{t('botSettings.extract.selectSession')}</label>
          <select
            value={selectedSession}
            onChange={e => setSelectedSession(e.target.value)}
            className="session-select"
          >
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {s.id} {s.port ? 'ًںں¢' : 'ًں”´'}
              </option>
            ))}
          </select>
        </div>

        {/* Chat List */}
        {loadingChats ? (
          <div className="loading"><Loader2 className="animate-spin" size={16} /> Loading chats...</div>
        ) : chats.length > 0 ? (
          <div className="chat-list-section">
            <div className="chat-list-header">
              <div className="chat-list-controls">
                <button className="btn-small" onClick={selectAll}><CheckSquare size={14} /> {t('botSettings.extract.selectAll')}</button>
                <button className="btn-small" onClick={deselectAll}><Square size={14} /> {t('botSettings.extract.deselectAll')}</button>
              </div>
              <div className="chat-search">
                <Search size={14} />
                <input
                  type="text"
                  placeholder={t('botSettings.extract.searchChats')}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                />
              </div>
            </div>
            <div className="chat-list">
              {filteredChats.map(chat => (
                <label key={chat.id} className="chat-item" onClick={() => toggleChat(chat.id)}>
                  <input type="checkbox" checked={selectedChatIds.has(chat.id)} onChange={() => {}} />
                  <div className="chat-info">
                    <span className="chat-name">{chat.name || chat.id.split('@')[0]}</span>
                    {chat.lastMessage && <span className="chat-last-msg">{chat.lastMessage}</span>}
                  </div>
                  <span className={`chat-badge ${chat.isGroup ? 'group' : 'private'}`}>
                    {chat.isGroup ? t('botSettings.extract.group') : t('botSettings.extract.private')}
                  </span>
                </label>
              ))}
            </div>
            <div className="chat-list-footer">
              <span>{selectedChatIds.size} / {chats.length} selected</span>
            </div>
          </div>
        ) : (
          <div className="empty-state">{t('botSettings.extract.noChats')}</div>
        )}

        {/* Scrape Button */}
        <div className="extract-actions">
          <button className="btn-primary" onClick={handleScrape} disabled={scraping || chats.length === 0}>
            {scraping ? <Loader2 className="animate-spin" size={16} /> : <Download size={16} />}
            <span>{scraping ? t('botSettings.extract.extracting') : (selectedChatIds.size > 0 ? `${t('botSettings.extract.extractBtn')} (${selectedChatIds.size})` : t('botSettings.extract.extractBtn'))}</span>
          </button>
        </div>

        {extractStatus && extractStatus.messagesExtracted && (
          <div className="extract-result">
            <div className="result-item"><span>Chats</span><strong>{extractStatus.chatsWithData}</strong></div>
            <div className="result-item"><span>Messages</span><strong>{extractStatus.messagesExtracted}</strong></div>
            <div className="result-item"><span>Pairs</span><strong>{extractStatus.pairsGenerated}</strong></div>
          </div>
        )}
      </div>

      {/* Upload & Clean */}
      <div className="tab-section">
        <h3 className="section-title">{t('botSettings.extract.hint')}</h3>
        <div className="clean-form">
          <input type="file" accept=".txt" onChange={handleFilePick} />
          <textarea
            placeholder={t('botSettings.extract.uploadPlaceholder') || 'Paste WhatsApp export text here...'}
            value={uploadText}
            onChange={e => setUploadText(e.target.value)}
            rows={5}
          />
          <button className="btn-primary" onClick={handleClean} disabled={cleaning || !uploadText.trim()}>
            {cleaning ? <Loader2 className="animate-spin" size={16} /> : <Upload size={16} />}
            <span>{t('botSettings.extract.uploadBtn')}</span>
          </button>
        </div>
      </div>

      {chatHistory?.exists && (
        <div className="tab-section">
          <h3 className="section-title">{t('botSettings.extract.preview')}</h3>
          <div className="chat-preview">
            <div className="preview-info">
              <span>{t('botSettings.extract.chatHistorySize')}: {(chatHistory.size / 1024).toFixed(1)} KB, {chatHistory.lines} lines</span>
            </div>
            <pre className="preview-text">{(chatHistory.preview || '').slice(0, 2000)}</pre>
          </div>
        </div>
      )}
    </>
  );
}

// â•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گ STYLE TAB â•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گ
// `t` and `extractStatus` are accepted for symmetry with the other tabs; this one is
// hardcoded Arabic rather than routed through i18n.
// `t` is accepted for symmetry with the other tabs; this one is hardcoded Arabic rather than
// routed through i18n.
function StyleTab({ extractStatus, toast }: TabCommonProps & { extractStatus: ExtractStatus | null }) {
  const [data, setData] = useState<StyleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [formality, setFormality] = useState('auto');
  const [responseLength, setResponseLength] = useState('auto');
  const [emojiUsage, setEmojiUsage] = useState('auto');
  const [customInstructions, setCustomInstructions] = useState('');

  const presets = [
    { label: 'ط±ط³ظ…ظٹ', icon: 'ًںژ©', formality: 'ط±ط³ظ…ظٹ', length: 'medium', emoji: 'ظ†ط§ط¯ط±ط§ظ‹', desc: 'ظ„ط؛ط© ط±ط³ظ…ظٹط© ظˆظ…ظ‡ط°ط¨ط©' },
    { label: 'ظˆط¯ظˆط¯', icon: 'ًں¤‌', formality: 'ط´ط¨ظ‡ ط±ط³ظ…ظٹ', length: 'medium', emoji: 'ط£ط­ظٹط§ظ†ط§ظ‹', desc: 'ظ„ط؛ط© ط·ط¨ظٹط¹ظٹط© ظˆظ„ط·ظٹظپط©' },
    { label: 'ط¹ظپظˆظٹ', icon: 'ًںک„', formality: 'ط¹ط§ظ…ظٹ', length: 'short', emoji: 'ظƒط«ظٹط±ط§ظ‹', desc: 'ظ…ط«ظ„ طµط¯ظٹظ‚ طھطھظƒظ„ظ… ظ…ط¹ط§ظ‡' },
    { label: 'ظ…ط®طھطµط±', icon: 'âڑ،', formality: 'ط¹ط§ظ…ظٹ', length: 'short', emoji: 'ط¨ط¯ظˆظ†', desc: 'ط±ط¯ظˆط¯ ظ‚طµظٹط±ط© ظˆط¨ط¯ظˆظ† ط²ظˆط§ط¦ط¯' },
    { label: 'طھظ„ظ‚ط§ط¦ظٹ', icon: 'âں³', formality: 'auto', length: 'auto', emoji: 'auto', desc: 'ط­ط³ط¨ طھط­ظ„ظٹظ„ ط§ظ„ط£ط³ظ„ظˆط¨' },
  ];

  const applyPreset = (p: typeof presets[0]) => {
    setFormality(p.formality);
    setResponseLength(p.length);
    setEmojiUsage(p.emoji);
    setDirty(true);
  };

  const loadStyle = (reanalyze = false) => {
    setLoading(true);
    fetch(`/bot-api/api/style${reanalyze ? '?reanalyze=true' : ''}`).then(r => r.json())
      .then(s => {
        setData(s);
        if (s.overrides) {
          setFormality(s.overrides.formality || 'auto');
          setResponseLength(s.overrides.responseLength || 'auto');
          setEmojiUsage(s.overrides.emojiUsage || 'auto');
          setCustomInstructions(s.overrides.customInstructions || '');
        }
        setDirty(false);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => { loadStyle(); }, [extractStatus]);

  const markDirty = () => setDirty(true);

  const saveOverrides = async () => {
    setSaving(true);
    try {
      const overrides: NonNullable<StyleData['overrides']> = {};
      if (formality !== 'auto') overrides.formality = formality;
      if (responseLength !== 'auto') overrides.responseLength = responseLength;
      if (emojiUsage !== 'auto') overrides.emojiUsage = emojiUsage;
      if (customInstructions.trim()) overrides.customInstructions = customInstructions.trim();

      const res = await fetch('/bot-api/api/style', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides }),
      }).then(r => r.json());

      if (res.success) {
        toast.success('طھظ… ط­ظپط¸ ط¥ط¹ط¯ط§ط¯ط§طھ ط§ظ„ط£ط³ظ„ظˆط¨ âœ“', '');
        setData(prev => ({ ...(prev ?? {}), overrides: res.overrides, systemPrompt: res.systemPrompt }));
        setDirty(false);
      } else {
        toast.error(res.error || 'ط­طµظ„ ط®ط·ط£ ظپظٹ ط§ظ„ط­ظپط¸', '');
      }
    } catch { toast.error('ط­طµظ„ ط®ط·ط£ ظپظٹ ط§ظ„ط­ظپط¸', ''); }
    setSaving(false);
  };

  const fp = data?.fingerprint;
  const noData = !data?.hasData;

  const getActivePreset = () => {
    const match = presets.find(p =>
      p.formality === formality && p.length === responseLength && p.emoji === emojiUsage
    );
    return match ? match.label : 'ظ…ط®طµطµ';
  };

  if (loading) return <div className="loading"><Loader2 className="animate-spin" size={18} /> طھط­ظ„ظٹظ„ ط§ظ„ط£ط³ظ„ظˆط¨...</div>;

  return (
    <div>
      {/* â”€â”€â”€ Presets â”€â”€â”€ */}
      <div className="tab-section">
        <div className="section-header">
          <h3 className="section-title">ط¥ط¹ط¯ط§ط¯ط§طھ ط§ظ„ط£ط³ظ„ظˆط¨</h3>
          <div className="section-actions">
            <button className="btn-secondary btn-sm" onClick={() => loadStyle(true)} disabled={loading}>
              <Sparkles size={14} /> ط¥ط¹ط§ط¯ط© ط§ظ„طھط­ظ„ظٹظ„
            </button>
          </div>
        </div>

        <div className="style-presets">
          {presets.map(p => (
            <button
              key={p.label}
              className={`style-preset-btn ${getActivePreset() === p.label ? 'active' : ''}`}
              onClick={() => applyPreset(p)}
            >
              <span className="style-preset-icon">{p.icon}</span>
              <span className="style-preset-label">{p.label}</span>
              <span className="style-preset-desc">{p.desc}</span>
            </button>
          ))}
        </div>

        {/* â”€â”€â”€ Controls Grid â”€â”€â”€ */}
        <div className="style-controls-grid">
          <div className="style-control-card">
            <div className="style-control-header">
              <span className="style-control-label">ظ…ط³طھظˆظ‰ ط§ظ„ط±ط³ظ…ظٹط©</span>
              {formality !== 'auto' && (
                <button className="btn-icon-xs" onClick={() => { setFormality('auto'); markDirty(); }} title="ط¥ط¹ط§ط¯ط© ظ„ظ„طھظ„ظ‚ط§ط¦ظٹ">
                  âں³
                </button>
              )}
            </div>
            <select className="style-select" value={formality} onChange={e => { setFormality(e.target.value); markDirty(); }}>
              <option value="auto">âں³ طھظ„ظ‚ط§ط¦ظٹ</option>
              <option value="ط±ط³ظ…ظٹ">ًںژ© ط±ط³ظ…ظٹ</option>
              <option value="ط´ط¨ظ‡ ط±ط³ظ…ظٹ">ًں¤‌ ط´ط¨ظ‡ ط±ط³ظ…ظٹ</option>
              <option value="ط¹ط§ظ…ظٹ">ًںک„ ط¹ط§ظ…ظٹ</option>
            </select>
            {fp && fp.formality && formality === 'auto' && (
              <div className="style-auto-hint">طھط­ظ„ظٹظ„: <span className={`badge-${fp.formality === 'ط±ط³ظ…ظٹ' ? 'formal' : fp.formality === 'ط¹ط§ظ…ظٹ' ? 'informal' : 'medium'}`}>{fp.formality}</span></div>
            )}
          </div>

          <div className="style-control-card">
            <div className="style-control-header">
              <span className="style-control-label">ط·ظˆظ„ ط§ظ„ط±ط¯</span>
              {responseLength !== 'auto' && (
                <button className="btn-icon-xs" onClick={() => { setResponseLength('auto'); markDirty(); }} title="ط¥ط¹ط§ط¯ط© ظ„ظ„طھظ„ظ‚ط§ط¦ظٹ">âں³</button>
              )}
            </div>
            <select className="style-select" value={responseLength} onChange={e => { setResponseLength(e.target.value); markDirty(); }}>
              <option value="auto">âں³ طھظ„ظ‚ط§ط¦ظٹ</option>
              <option value="short">ظ‚طµظٹط± (ط¬ظ…ظ„ط©)</option>
              <option value="medium">ظ…طھظˆط³ط· (ط¬ظ…ظ„طھظٹظ†-ط«ظ„ط§ط«)</option>
              <option value="long">ط·ظˆظٹظ„ (ظپظ‚ط±ط©)</option>
            </select>
            {fp && responseLength === 'auto' && (
              <div className="style-auto-hint">طھط­ظ„ظٹظ„: {fp.avgMessageWords || fp.avgResponseLength} ظƒظ„ظ…ط§طھ</div>
            )}
          </div>

          <div className="style-control-card">
            <div className="style-control-header">
              <span className="style-control-label">ط§ظ„ط¥ظٹظ…ظˆط¬ظٹط²</span>
              {emojiUsage !== 'auto' && (
                <button className="btn-icon-xs" onClick={() => { setEmojiUsage('auto'); markDirty(); }} title="ط¥ط¹ط§ط¯ط© ظ„ظ„طھظ„ظ‚ط§ط¦ظٹ">âں³</button>
              )}
            </div>
            <select className="style-select" value={emojiUsage} onChange={e => { setEmojiUsage(e.target.value); markDirty(); }}>
              <option value="auto">âں³ طھظ„ظ‚ط§ط¦ظٹ</option>
              <option value="ظƒط«ظٹط±ط§ظ‹">ظƒط«ظٹط±ط§ظ‹ ًںک„</option>
              <option value="ط£ط­ظٹط§ظ†ط§ظ‹">ط£ط­ظٹط§ظ†ط§ظ‹ ًں™‚</option>
              <option value="ظ†ط§ط¯ط±ط§ظ‹">ظ†ط§ط¯ط±ط§ظ‹ ًںکگ</option>
              <option value="ط¨ط¯ظˆظ†">ط¨ط¯ظˆظ† ًںڑ«</option>
            </select>
            {fp && emojiUsage === 'auto' && (
              <div className="style-auto-hint">طھط­ظ„ظٹظ„: {fp.emojiUsage?.usage || 'â€”'} ({fp.emojiUsage?.avgPerMessage?.toFixed(1) || '0'}/msg)</div>
            )}
          </div>

          <div className="style-control-card">
            <span className="style-control-label">ط§ظ„ظ„ط؛ط©</span>
            <div className="style-control-readonly">{fp ? fp.languageMix?.dominant || '?' : 'â€”'}</div>
            {fp?.languageMix && (
              <div className="style-auto-hint">
                <span className="lang-bar"><span className="lang-bar-ar" style={{width: `${fp.languageMix.arabicPercent}%`}} /> ط¹ط±ط¨ظٹ {fp.languageMix.arabicPercent}%</span>
                <span className="lang-bar"><span className="lang-bar-en" style={{width: `${fp.languageMix.englishPercent}%`}} /> ط¥ظ†ط¬ظ„ظٹط²ظٹ {fp.languageMix.englishPercent}%</span>
              </div>
            )}
          </div>

          <div className="style-control-card">
            <span className="style-control-label">ط§ظ„ط±ط³ط§ط¦ظ„ ط§ظ„ظ…ط­ظ„ظ„ط©</span>
            <div className="style-control-readonly">{fp ? fp.messagesAnalyzed : 'â€”'}</div>
            {fp && <div className="style-auto-hint">ط¥ط¬ظ…ط§ظ„ظٹ ط§ظ„ظ…ط­ط§ط¯ط«ط§طھ: {fp.totalConversations || 'â€”'}</div>}
          </div>

          <div className="style-control-card">
            <span className="style-control-label">ط¹ظ„ط§ظ…ط§طھ ط§ظ„طھط±ظ‚ظٹظ…</span>
            <div className="style-control-readonly">{fp?.punctuation?.dominant || 'â€”'}</div>
            {fp?.punctuation && (
              <div className="style-punct-bars">
                <span>. {fp.punctuation.period}%</span>
                <span>! {fp.punctuation.exclamation}%</span>
                <span>? {fp.punctuation.question}%</span>
              </div>
            )}
          </div>
        </div>

        {/* â”€â”€â”€ Custom Instructions â”€â”€â”€ */}
        <div className="style-instructions-section">
          <label className="style-control-label">طھط¹ظ„ظٹظ…ط§طھ ط¥ط¶ط§ظپظٹط©</label>
          <textarea
            className="style-instructions-input"
            placeholder='"ط§ط³طھط®ط¯ظ… ظ„ط؛ط© ظˆط¯ظٹط©", "طھط¬ظ†ط¨ ط§ظ„ظ…طµط·ظ„ط­ط§طھ ط§ظ„طھظ‚ظ†ظٹط©", "ط£ط¶ظپ ط¯ط¹ط§ط، ظپظٹ ظ†ظ‡ط§ظٹط© ط§ظ„ط±ط¯"...'
            value={customInstructions}
            onChange={e => { setCustomInstructions(e.target.value); markDirty(); }}
            rows={3}
          />
        </div>

        {/* â”€â”€â”€ Save â”€â”€â”€ */}
        <div className="style-save-section">
          <button className="btn-primary" onClick={saveOverrides} disabled={saving || !dirty}>
            {saving ? <Loader2 className="animate-spin" size={16} /> : null}
            {saving ? 'ط¬ط§ط±ظٹ ط§ظ„ط­ظپط¸...' : dirty ? 'ًں’¾ ط­ظپط¸ ط¥ط¹ط¯ط§ط¯ط§طھ ط§ظ„ط£ط³ظ„ظˆط¨' : 'âœ“ طھظ… ط§ظ„ط­ظپط¸'}
          </button>
          {!dirty && <span className="style-saved-hint">ط¬ظ…ظٹط¹ ط§ظ„ط¥ط¹ط¯ط§ط¯ط§طھ ظ…ط­ظپظˆط¸ط©</span>}
        </div>
      </div>

      {/* â”€â”€â”€ Analyzed Data â”€â”€â”€ */}
      {fp && (
        <>
          <div className="tab-section">
            <h3 className="section-title">ط§ظ„طھط­ظٹط§طھ</h3>
            <div className="phrase-list">
              {(fp.commonGreetings || []).length > 0
                ? (fp.commonGreetings || []).map((g: string, i: number) => <span key={i} className="phrase-tag">{g}</span>)
                : <span className="empty-state-sm">â€”</span>}
            </div>
          </div>

          <div className="tab-section">
            <h3 className="section-title">ط§ظ„ط®طھط§ظ…ظٹط§طھ</h3>
            <div className="phrase-list">
              {(fp.commonSignoffs || []).length > 0
                ? (fp.commonSignoffs || []).map((s: string, i: number) => <span key={i} className="phrase-tag">{s}</span>)
                : <span className="empty-state-sm">â€”</span>}
            </div>
          </div>

          <div className="tab-section">
            <h3 className="section-title">ط§ظ„ط¹ط¨ط§ط±ط§طھ ط§ظ„ظ…طھظƒط±ط±ط©</h3>
            <div className="phrase-list">
              {(fp.topPhrases || []).length > 0
                ? (fp.topPhrases || []).slice(0, 8).map((p, i) => (
                    <span key={i} className="phrase-tag">{p.phrase} <small>{p.count}</small></span>
                  ))
                : <span className="empty-state-sm">â€”</span>}
            </div>
          </div>

          {fp.responseStyle && (
            <div className="tab-section">
              <h3 className="section-title">ط£ط³ظ„ظˆط¨ ط§ظ„ط±ط¯</h3>
              <p className="response-style">{fp.responseStyle}</p>
            </div>
          )}

          {/* System Prompt Preview */}
          {data?.systemPrompt && (
            <div className="tab-section">
              <div className="section-header">
                <h3 className="section-title">ظ…ط¹ط§ظٹظ†ط© ط§ظ„طھط¹ظ„ظٹظ…ط§طھ</h3>
                <button className="btn-secondary btn-sm" onClick={saveOverrides} disabled={saving || !dirty}>
                  طھط­ط¯ظٹط« ط§ظ„ظ…ط¹ط§ظٹظ†ط©
                </button>
              </div>
              <pre className="preview-text">{data.systemPrompt}</pre>
            </div>
          )}
        </>
      )}

      {noData && (
        <div className="empty-state">
          <p>ظ…ط§ظپظٹط´ ط¨ظٹط§ظ†ط§طھ ط£ط³ظ„ظˆط¨. ط§ط³طھط®ط±ط¬ ظ…ط­ط§ط¯ط«ط§طھ ط£ظˆظ„ ط£ظˆ ط§ط±ظپط¹ ظ…ظ„ظپ ظˆط§طھط³ط§ط¨.</p>
          <button className="btn-primary" onClick={() => loadStyle(true)} disabled={loading}>
            <Sparkles size={14} /> طھط­ظ„ظٹظ„ ط§ظ„ط£ط³ظ„ظˆط¨
          </button>
        </div>
      )}
    </div>
  );
}

// â•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گ RULES TAB â•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گ
// `t` is accepted for symmetry with the other tabs; this one is hardcoded Arabic.
function RulesTab({ toast }: TabCommonProps) {
  const [rules, setRules] = useState<RuleItem[]>([]);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ trigger: '', response: '', context: '' });

  const loadRules = () => {
    fetch('/bot-api/api/rules').then(r => r.json()).then(d => setRules(d.rules || [])).catch(() => {});
  };

  useEffect(loadRules, []);

  const resetForm = () => { setForm({ trigger: '', response: '', context: '' }); setEditId(null); setShowForm(false); };

  const saveRule = async () => {
    if (!form.trigger || !form.response) return;
    try {
      if (editId) {
        const res = await fetch(`/bot-api/api/rules/${editId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trigger: form.trigger, response: form.response, context: form.context }),
        }).then(r => r.json());
        if (!res.error) { setRules(prev => prev.map(r => r.id === editId ? res : r)); toast.success('طھظ… ط§ظ„طھط¹ط¯ظٹظ„ âœ“', ''); resetForm(); }
      } else {
        const res = await fetch('/bot-api/api/rules', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trigger: form.trigger, response: form.response, context: form.context }),
        }).then(r => r.json());
        if (!res.error) { setRules(prev => [...prev, res]); toast.success('طھظ…طھ ط§ظ„ط¥ط¶ط§ظپط© âœ“', ''); resetForm(); }
      }
    } catch { toast.error('ط­طµظ„ ط®ط·ط£', ''); }
  };

  const toggleRule = async (id: string, enabled: boolean) => {
    try {
      const res = await fetch(`/bot-api/api/rules/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      }).then(r => r.json());
      if (!res.error) setRules(prev => prev.map(r => r.id === id ? res : r));
    } catch { toast.error('ط­طµظ„ ط®ط·ط£', ''); }
  };

  const deleteRule = async (id: string) => {
    try {
      const res = await fetch(`/bot-api/api/rules/${id}`, { method: 'DELETE' }).then(r => r.json());
      if (res.removed) {
        setRules(prev => prev.filter(r => r.id !== id));
        toast.success('طھظ… ط§ظ„ط­ط°ظپ âœ“', '');
      } else {
        toast.error(res.error || 'ظپط´ظ„ ط§ظ„ط­ط°ظپ', '');
      }
    } catch { toast.error('ط­طµظ„ ط®ط·ط£', ''); }
  };

  const startEdit = (rule: RuleItem) => {
    setForm({ trigger: rule.trigger, response: rule.response, context: rule.context || '' });
    setEditId(rule.id);
    setShowForm(true);
  };

  const filtered = rules.filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return r.trigger.includes(q) || r.response.includes(q) || (r.context || '').includes(q);
  });

  return (
    <div>
      {/* â”€â”€â”€ Header â”€â”€â”€ */}
      <div className="tab-section">
        <div className="section-header">
          <h3 className="section-title">ط§ظ„ظ‚ظˆط§ط¹ط¯ ({rules.length})</h3>
          <button className={`btn-${showForm ? 'secondary' : 'primary'} btn-sm`} onClick={() => { resetForm(); setShowForm(!showForm); }}>
            {showForm ? 'âœ• ط¥ظ„ط؛ط§ط،' : '+ ط¥ط¶ط§ظپط© ظ‚ط§ط¹ط¯ط©'}
          </button>
        </div>

        {/* â”€â”€â”€ Form â”€â”€â”€ */}
        {showForm && (
          <div className="rule-form-card">
            <div className="rule-form-row">
              <div className="rule-form-field">
                <label>ظƒظ„ظ…ط© ط§ظ„ط²ظ†ط§ط¯ (trigger)</label>
                <input placeholder="ظ…ط«ط§ظ„: ظƒظ… ط§ظ„ط³ط¹ط±" value={form.trigger} onChange={e => setForm(prev => ({ ...prev, trigger: e.target.value }))} autoFocus />
              </div>
              <div className="rule-form-field">
                <label>ط§ظ„ط±ط¯</label>
                <input placeholder="ظ…ط«ط§ظ„: ط§ظ„ط³ط¹ط± ظƒط°ط§" value={form.response} onChange={e => setForm(prev => ({ ...prev, response: e.target.value }))} />
              </div>
            </div>
            <div className="rule-form-field">
              <label>ط³ظٹط§ظ‚ (ط§ط®طھظٹط§ط±ظٹ)</label>
              <input placeholder="ظ…ط«ط§ظ„: ظ„ظˆ ط³ط£ظ„ ط¹ظ† ط§ظ„ط³ط¹ط±" value={form.context} onChange={e => setForm(prev => ({ ...prev, context: e.target.value }))} />
            </div>
            <div className="rule-form-actions">
              <button className="btn-primary btn-sm" onClick={saveRule} disabled={!form.trigger || !form.response}>
                {editId ? 'ًں’¾ ط­ظپط¸ ط§ظ„طھط¹ط¯ظٹظ„' : 'â‍• ط¥ط¶ط§ظپط© ط§ظ„ظ‚ط§ط¹ط¯ط©'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* â”€â”€â”€ Search â”€â”€â”€ */}
      {rules.length > 0 && (
        <div className="list-search" style={{ marginBottom: '0.75rem' }}>
          <span className="list-search-icon">ًں”چ</span>
          <input placeholder="ط§ط¨ط­ط« ظپظٹ ط§ظ„ظ‚ظˆط§ط¹ط¯..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      )}

      {/* â”€â”€â”€ List â”€â”€â”€ */}
      {filtered.length > 0 ? (
        <div className="tab-section">
          <div className="rules-list">
            {filtered.map(r => (
              <div key={r.id} className={`rule-card ${r.enabled === false ? 'disabled' : ''}`}>
                <div className="rule-card-main">
                  <div className="rule-card-content">
                    <div className="rule-card-trigger">
                      <span className="rule-card-badge">if</span>
                      {r.trigger}
                    </div>
                    <div className="rule-card-arrow">â†’</div>
                    <div className="rule-card-response">{r.response}</div>
                  </div>
                  {r.context && <div className="rule-card-context">ًں“ژ {r.context}</div>}
                </div>
                <div className="rule-card-actions">
                  <button
                    className={`toggle-btn ${r.enabled !== false ? 'on' : 'off'}`}
                    onClick={() => toggleRule(r.id, r.enabled !== false)}
                    title={r.enabled !== false ? 'طھط¹ط·ظٹظ„' : 'طھظپط¹ظٹظ„'}
                  >
                    <span className="toggle-knob" />
                  </button>
                  <button className="btn-icon-sm" onClick={() => startEdit(r)} title="طھط¹ط¯ظٹظ„">âœڈï¸ڈ</button>
                  <button className="btn-icon-sm danger" onClick={() => deleteRule(r.id)} title="ط­ط°ظپ">ًں—‘ï¸ڈ</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : rules.length > 0 ? (
        <div className="empty-state-sm">ظ„ط§ طھظˆط¬ط¯ ظ†طھط§ط¦ط¬ ظ„ظ„ط¨ط­ط« "{search}"</div>
      ) : (
        <div className="empty-state">
          <p>ظ…ط§ظپظٹط´ ظ‚ظˆط§ط¹ط¯ ظ…ط¶ط§ظپط©. ط£ط¶ظپ ظ‚ط§ط¹ط¯ط© ط¹ط´ط§ظ† ط§ظ„ط¨ظˆطھ ظٹط±ط¯ طھظ„ظ‚ط§ط¦ظٹط§ظ‹ ط¹ظ„ظ‰ ظƒظ„ظ…ط§طھ ظ…ط¹ظٹظ†ط©.</p>
        </div>
      )}
    </div>
  );
}

// â•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گ KEYWORDS TAB â•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گ
// `t` is accepted for symmetry with the other tabs; this one is hardcoded Arabic.
function KeywordsTab({ toast }: TabCommonProps) {
  const [items, setItems] = useState<KeywordItem[]>([]);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [keywordInput, setKeywordInput] = useState('');
  const [form, setForm] = useState({ keywords: [] as string[], reply: '', context: '' });

  const loadItems = () => {
    fetch('/bot-api/api/keywords').then(r => r.json()).then(setItems).catch(() => {});
  };

  useEffect(loadItems, []);

  const resetForm = () => { setForm({ keywords: [], reply: '', context: '' }); setKeywordInput(''); setEditId(null); setShowForm(false); };

  const addKeyword = () => {
    const kw = keywordInput.trim().toLowerCase();
    if (kw) {
      setForm(prev => {
        if (prev.keywords.includes(kw)) return prev;
        return { ...prev, keywords: [...prev.keywords, kw] };
      });
    }
    setKeywordInput('');
  };

  const removeKeyword = (kw: string) => {
    setForm(prev => ({ ...prev, keywords: prev.keywords.filter(k => k !== kw) }));
  };

  const handleKeywordKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); addKeyword(); }
  };

  const saveItem = async () => {
    if (form.keywords.length === 0 || !form.reply) return;
    try {
      if (editId) {
        const res = await fetch(`/bot-api/api/keywords/${editId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keywords: form.keywords, reply: form.reply, context: form.context }),
        }).then(r => r.json());
        if (!res.error) { setItems(prev => prev.map(i => i.id === editId ? res : i)); toast.success('طھظ… ط§ظ„طھط¹ط¯ظٹظ„ âœ“', ''); resetForm(); }
      } else {
        const res = await fetch('/bot-api/api/keywords', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keywords: form.keywords, reply: form.reply, context: form.context }),
        }).then(r => r.json());
        if (!res.error) { setItems(prev => [...prev, res]); toast.success('طھظ…طھ ط§ظ„ط¥ط¶ط§ظپط© âœ“', ''); resetForm(); }
      }
    } catch { toast.error('ط­طµظ„ ط®ط·ط£', ''); }
  };

  const toggleItem = async (id: string, enabled: boolean) => {
    try {
      const res = await fetch(`/bot-api/api/keywords/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      }).then(r => r.json());
      if (!res.error) setItems(prev => prev.map(i => i.id === id ? res : i));
    } catch { toast.error('ط­طµظ„ ط®ط·ط£', ''); }
  };

  const deleteItem = async (id: string) => {
    try {
      const res = await fetch(`/bot-api/api/keywords/${id}`, { method: 'DELETE' }).then(r => r.json());
      if (res.removed) {
        setItems(prev => prev.filter(i => i.id !== id));
        toast.success('طھظ… ط§ظ„ط­ط°ظپ âœ“', '');
      } else {
        toast.error(res.error || 'ظپط´ظ„ ط§ظ„ط­ط°ظپ', '');
      }
    } catch { toast.error('ط­طµظ„ ط®ط·ط£', ''); }
  };

  const startEdit = (item: KeywordItem) => {
    setForm({ keywords: [...(item.keywords || [])], reply: item.reply, context: item.context || '' });
    setEditId(item.id);
    setShowForm(true);
  };

  const filtered = items.filter(item => {
    if (!search) return true;
    const q = search.toLowerCase();
    return item.keywords?.some((k: string) => k.includes(q)) || item.reply.includes(q);
  });

  return (
    <div>
      {/* â”€â”€â”€ Header â”€â”€â”€ */}
      <div className="tab-section">
        <div className="section-header">
          <h3 className="section-title">ط§ظ„ظƒظ„ظ…ط§طھ ط§ظ„ظ…ظپطھط§ط­ظٹط© ({items.length})</h3>
          <button className={`btn-${showForm ? 'secondary' : 'primary'} btn-sm`} onClick={() => { resetForm(); setShowForm(!showForm); }}>
            {showForm ? 'âœ• ط¥ظ„ط؛ط§ط،' : '+ ط¥ط¶ط§ظپط© ظƒظ„ظ…ط§طھ'}
          </button>
        </div>

        {/* â”€â”€â”€ Form â”€â”€â”€ */}
        {showForm && (
          <div className="rule-form-card">
            <div className="rule-form-field">
              <label>ط§ظ„ظƒظ„ظ…ط§طھ ط§ظ„ظ…ظپطھط§ط­ظٹط© (ط§ظƒطھط¨ ظƒظ„ظ…ط© ظˆط¥ط¶ط؛ط· Enter)</label>
              <div className="keyword-chips-input">
                {form.keywords.map(kw => (
                  <span key={kw} className="kw-chip">
                    {kw}
                    <button className="kw-chip-remove" onClick={() => removeKeyword(kw)}>أ—</button>
                  </span>
                ))}
                <input
                  className="kw-input"
                  placeholder={form.keywords.length === 0 ? 'ظ…ط«ط§ظ„: ط³ظ„ط§ظ…, ظ…ط±ط­ط¨ط§, ظ‡ظ„ط§' : 'ط§ظƒظ„ظ…ط© ط¬ط¯ظٹط¯ط©...'}
                  value={keywordInput}
                  onChange={e => setKeywordInput(e.target.value)}
                  onKeyDown={handleKeywordKey}
                  onBlur={addKeyword}
                  autoFocus
                />
              </div>
            </div>
            <div className="rule-form-field">
              <label>ط§ظ„ط±ط¯</label>
              <input placeholder="ظ…ط«ط§ظ„: ظˆط¹ظ„ظٹظƒظ… ط§ظ„ط³ظ„ط§ظ…" value={form.reply} onChange={e => setForm(prev => ({ ...prev, reply: e.target.value }))} />
            </div>
            <div className="rule-form-field">
              <label>ط³ظٹط§ظ‚ (ط§ط®طھظٹط§ط±ظٹ)</label>
              <input placeholder="ظ…ط«ط§ظ„: ظ„ظ„طھط±ط­ظٹط¨ ظپظ‚ط·" value={form.context} onChange={e => setForm(prev => ({ ...prev, context: e.target.value }))} />
            </div>
            <div className="rule-form-actions">
              <button className="btn-primary btn-sm" onClick={saveItem} disabled={form.keywords.length === 0 || !form.reply}>
                {editId ? 'ًں’¾ ط­ظپط¸ ط§ظ„طھط¹ط¯ظٹظ„' : 'â‍• ط¥ط¶ط§ظپط© ط§ظ„ظ‚ط§ط¹ط¯ط©'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* â”€â”€â”€ Search â”€â”€â”€ */}
      {items.length > 0 && (
        <div className="list-search" style={{ marginBottom: '0.75rem' }}>
          <span className="list-search-icon">ًں”چ</span>
          <input placeholder="ط§ط¨ط­ط« ظپظٹ ط§ظ„ظƒظ„ظ…ط§طھ ط§ظ„ظ…ظپطھط§ط­ظٹط©..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      )}

      {/* â”€â”€â”€ List â”€â”€â”€ */}
      {filtered.length > 0 ? (
        <div className="tab-section">
          <div className="rules-list">
            {filtered.map(item => (
              <div key={item.id} className={`rule-card ${item.enabled === false ? 'disabled' : ''}`}>
                <div className="rule-card-main">
                  <div className="rule-card-content">
                    <div className="rule-card-keywords">
                      {(item.keywords || []).map((kw: string) => (
                        <span key={kw} className="kw-badge">{kw}</span>
                      ))}
                    </div>
                    <div className="rule-card-arrow">â†’</div>
                    <div className="rule-card-response">{item.reply}</div>
                  </div>
                  {item.context && <div className="rule-card-context">ًں“ژ {item.context}</div>}
                </div>
                <div className="rule-card-actions">
                  <button
                    className={`toggle-btn ${item.enabled !== false ? 'on' : 'off'}`}
                    onClick={() => toggleItem(item.id, item.enabled !== false)}
                    title={item.enabled !== false ? 'طھط¹ط·ظٹظ„' : 'طھظپط¹ظٹظ„'}
                  >
                    <span className="toggle-knob" />
                  </button>
                  <button className="btn-icon-sm" onClick={() => startEdit(item)} title="طھط¹ط¯ظٹظ„">âœڈï¸ڈ</button>
                  <button className="btn-icon-sm danger" onClick={() => deleteItem(item.id)} title="ط­ط°ظپ">ًں—‘ï¸ڈ</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : items.length > 0 ? (
        <div className="empty-state-sm">ظ„ط§ طھظˆط¬ط¯ ظ†طھط§ط¦ط¬ ظ„ظ„ط¨ط­ط« "{search}"</div>
      ) : (
        <div className="empty-state">
          <p>ظ…ط§ظپظٹط´ ظƒظ„ظ…ط§طھ ظ…ظپطھط§ط­ظٹط©. ط£ط¶ظپ ظƒظ„ظ…ط§طھ ط¹ط´ط§ظ† ط§ظ„ط¨ظˆطھ ظٹط±ط¯ ط¹ظ„ظٹظ‡ط§ طھظ„ظ‚ط§ط¦ظٹط§ظ‹.</p>
        </div>
      )}
    </div>
  );
}

// â•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گ MEMORY TAB â•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گâ•گ
function MemoryTab({ t, toast }: TabCommonProps) {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/bot-api/api/memory')
      .then(r => r.json())
      .then(data => {
        const arr = Array.isArray(data) ? data : Object.entries(data).map(([chatId, mem]) => ({ chatId, ...(typeof mem === 'object' ? mem : { memory: mem }) }));
        setMemories(arr);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const clearMemory = async (chatId: string) => {
    try {
      const res = await fetch(`/bot-api/api/memory/${chatId}`, { method: 'DELETE' }).then(r => r.json());
      if (res.deleted || res.removed) {
        setMemories(prev => prev.filter(m => m.chatId !== chatId));
        toast.success(t('botSettings.memory.cleared'), '');
      } else {
        toast.error(res.error || t('botSettings.memory.error'), '');
      }
    } catch { toast.error(t('botSettings.memory.error'), ''); }
  };

  if (loading) return <div className="loading">{t('botSettings.loading')}</div>;
  if (memories.length === 0) return <div className="empty-state">{t('botSettings.memory.empty')}</div>;

  return (
    <div className="tab-section">
      <h3 className="section-title">{t('botSettings.memory.title')} ({memories.length})</h3>
      <div className="memory-list">
        {memories.map(m => (
          <div key={m.chatId || m.id} className="memory-item">
            <div className="memory-chat">{m.chatId || m.id}</div>
            <div className="memory-data">{(m.memory || m.data || '').slice(0, 100)}</div>
            <button className="btn-danger" onClick={() => clearMemory(m.chatId || m.id || '')}>âœ•</button>
          </div>
        ))}
      </div>
    </div>
  );
}
