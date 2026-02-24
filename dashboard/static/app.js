/* =====================================================================
   OpenPlanter Dashboard – Frontend Application
   ===================================================================== */

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
const navItems = document.querySelectorAll('.nav-item[data-page]');
const pages = document.querySelectorAll('.page');

function navigateTo(pageId) {
    pages.forEach(p => p.classList.remove('active'));
    navItems.forEach(n => n.classList.remove('active'));

    const page = document.getElementById('page-' + pageId);
    const nav = document.querySelector(`.nav-item[data-page="${pageId}"]`);
    if (page) page.classList.add('active');
    if (nav) nav.classList.add('active');

    // Load data for page
    switch (pageId) {
        case 'overview': loadOverview(); break;
        case 'sessions': loadSessions(); break;
        case 'scripts': loadScripts(); break;
        case 'files': loadFiles(''); break;
        case 'wiki': loadWiki(); break;
        case 'config': loadConfig(); break;
        case 'investigate': break;
    }
}

navItems.forEach(item => {
    item.addEventListener('click', () => navigateTo(item.dataset.page));
});

// Tab system
document.querySelectorAll('.tabs').forEach(tabBar => {
    tabBar.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            tabBar.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const contentId = tab.dataset.tab;
            // Find sibling tab-contents
            let sibling = tabBar.nextElementSibling;
            while (sibling && sibling.classList.contains('tab-content')) {
                sibling.classList.remove('active');
                if (sibling.id === contentId) sibling.classList.add('active');
                sibling = sibling.nextElementSibling;
            }
        });
    });
});

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function api(url, options = {}) {
    const resp = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    return resp.json();
}

function formatDate(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
}

function formatSize(bytes) {
    if (!bytes && bytes !== 0) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
async function loadOverview() {
    try {
        const data = await api('/api/overview');

        document.getElementById('ov-sessions').textContent = data.session_count;
        document.getElementById('ov-fetchers').textContent = data.fetcher_script_count;
        document.getElementById('ov-analysis').textContent = data.analysis_script_count;
        document.getElementById('ov-providers').textContent = data.providers_configured.length;
        document.getElementById('ov-provider-list').textContent = data.providers_configured.join(', ') || 'None configured';
        document.getElementById('session-count').textContent = data.session_count;

        const container = document.getElementById('ov-recent-sessions');
        if (!data.recent_sessions || data.recent_sessions.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <h3>No sessions yet</h3>
                    <p>Launch an investigation to create your first session.</p>
                </div>`;
        } else {
            let html = '<table><thead><tr><th>Session ID</th><th>Created</th></tr></thead><tbody>';
            data.recent_sessions.forEach(s => {
                html += `<tr style="cursor:pointer" onclick="navigateTo('sessions'); setTimeout(() => viewSession('${s.session_id}'), 100)">
                    <td><code>${escapeHtml(s.session_id)}</code></td>
                    <td>${formatDate(s.created_at)}</td>
                </tr>`;
            });
            html += '</tbody></table>';
            container.innerHTML = html;
        }
    } catch (e) {
        console.error('Failed to load overview:', e);
    }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
async function loadSessions() {
    const container = document.getElementById('sessions-table');
    container.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';

    try {
        const sessions = await api('/api/sessions');
        document.getElementById('session-count').textContent = sessions.length;

        if (sessions.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">&#128269;</div>
                    <h3>No sessions found</h3>
                    <p>Run an investigation to create a session.</p>
                </div>`;
            return;
        }

        let html = `<table><thead><tr>
            <th>Session ID</th>
            <th>Objective</th>
            <th>Events</th>
            <th>Artifacts</th>
            <th>Created</th>
            <th></th>
        </tr></thead><tbody>`;

        sessions.forEach(s => {
            const obj = s.objectives && s.objectives.length > 0
                ? escapeHtml(s.objectives[0].substring(0, 80)) + (s.objectives[0].length > 80 ? '...' : '')
                : '<span class="text-muted">-</span>';
            html += `<tr>
                <td><code>${escapeHtml(s.session_id)}</code></td>
                <td style="max-width:300px">${obj}</td>
                <td>${s.event_count}</td>
                <td>${s.artifact_count}</td>
                <td>${formatDate(s.created_at)}</td>
                <td><button class="btn btn-sm btn-primary" onclick="viewSession('${s.session_id}')">View</button></td>
            </tr>`;
        });

        html += '</tbody></table>';
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<div class="empty-state"><h3>Error loading sessions</h3><p>${escapeHtml(String(e))}</p></div>`;
    }
}

function showSessionsList() {
    document.getElementById('sessions-list-view').style.display = '';
    document.getElementById('session-detail-view').style.display = 'none';
}

async function viewSession(sessionId) {
    document.getElementById('sessions-list-view').style.display = 'none';
    document.getElementById('session-detail-view').style.display = '';
    document.getElementById('sd-title').textContent = 'Session';
    document.getElementById('sd-id').textContent = sessionId;
    document.getElementById('sd-event-log').innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';

    try {
        const data = await api(`/api/sessions/${sessionId}`);

        document.getElementById('sd-created').textContent = formatDate(data.state?.saved_at);
        document.getElementById('sd-events-count').textContent = data.event_count;
        document.getElementById('sd-artifact-count').textContent = data.artifacts.length;

        // Events
        const eventLog = document.getElementById('sd-event-log');
        if (data.events.length === 0) {
            eventLog.innerHTML = '<div class="empty-state"><p>No events recorded.</p></div>';
        } else {
            let html = '';
            data.events.forEach(evt => {
                const time = evt.ts ? new Date(evt.ts).toLocaleTimeString() : '';
                const typeClass = 'event-type-' + (evt.type || 'trace');
                let content = '';

                if (evt.type === 'objective') {
                    content = escapeHtml(evt.payload?.text || '');
                } else if (evt.type === 'result') {
                    const text = evt.payload?.text || '';
                    content = escapeHtml(text.substring(0, 300)) + (text.length > 300 ? '...' : '');
                } else if (evt.type === 'step') {
                    const action = evt.payload?.action;
                    if (action && action.name) {
                        content = `<code>${escapeHtml(action.name)}</code>`;
                        if (action.arguments) {
                            const args = Object.keys(action.arguments).slice(0, 3).join(', ');
                            content += ` <span class="text-muted">(${escapeHtml(args)})</span>`;
                        }
                    } else {
                        content = '<span class="text-muted">step</span>';
                    }
                } else if (evt.type === 'trace') {
                    content = escapeHtml((evt.payload?.message || '').substring(0, 200));
                } else if (evt.type === 'artifact') {
                    content = `<code>${escapeHtml(evt.payload?.path || '')}</code>`;
                } else {
                    content = escapeHtml(JSON.stringify(evt.payload || {}).substring(0, 200));
                }

                html += `<div class="event-item">
                    <span class="event-time">${time}</span>
                    <span class="event-type ${typeClass}">${evt.type}</span>
                    <span class="event-content">${content}</span>
                </div>`;
            });
            eventLog.innerHTML = html;
        }

        // Turn history
        const turnList = document.getElementById('sd-turn-list');
        if (!data.turn_history || data.turn_history.length === 0) {
            turnList.innerHTML = '<div class="empty-state"><p>No turn history recorded.</p></div>';
        } else {
            let html = '<table><thead><tr><th>#</th><th>Objective</th><th>Steps</th><th>Result Preview</th><th>Time</th></tr></thead><tbody>';
            data.turn_history.forEach(t => {
                html += `<tr>
                    <td>${t.turn_number}</td>
                    <td style="max-width:250px">${escapeHtml((t.objective || '').substring(0, 80))}</td>
                    <td>${t.steps_used || '-'}</td>
                    <td style="max-width:300px" class="text-muted">${escapeHtml((t.result_preview || '').substring(0, 100))}</td>
                    <td>${formatDate(t.timestamp)}</td>
                </tr>`;
            });
            html += '</tbody></table>';
            turnList.innerHTML = html;
        }

        // Artifacts
        const artifactList = document.getElementById('sd-artifact-list');
        if (data.artifacts.length === 0) {
            artifactList.innerHTML = '<div class="empty-state"><p>No artifacts in this session.</p></div>';
        } else {
            let html = '';
            data.artifacts.forEach(a => {
                html += `<div class="file-item" onclick="viewArtifact('${sessionId}', '${a.path}')">
                    <span class="file-icon">&#128196;</span>
                    <span class="file-name">${escapeHtml(a.path)}</span>
                    <span class="file-size">${formatSize(a.size)}</span>
                </div>`;
            });
            artifactList.innerHTML = html;
        }
    } catch (e) {
        document.getElementById('sd-event-log').innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(String(e))}</p></div>`;
    }
}

async function viewArtifact(sessionId, path) {
    try {
        const data = await api(`/api/sessions/${sessionId}/artifacts/${path}`);
        // Show in a simple modal/overlay via the file content card approach
        const container = document.getElementById('sd-artifact-list');
        container.innerHTML = `
            <div style="padding: 14px;">
                <div class="flex items-center justify-between mb-2">
                    <strong>${escapeHtml(path)}</strong>
                    <button class="btn btn-sm" onclick="viewSession('${sessionId}')">Close</button>
                </div>
                <pre>${escapeHtml(data.content)}</pre>
            </div>`;
    } catch (e) {
        alert('Error loading artifact: ' + e);
    }
}

// ---------------------------------------------------------------------------
// Scripts / Data Sources
// ---------------------------------------------------------------------------
async function loadScripts() {
    try {
        const data = await api('/api/scripts');

        // Fetchers
        const fetcherContainer = document.getElementById('fetchers-list');
        if (data.fetchers.length === 0) {
            fetcherContainer.innerHTML = '<div class="empty-state"><p>No fetcher scripts found.</p></div>';
        } else {
            let html = '<table><thead><tr><th>Script</th><th>Description</th><th>Size</th><th></th></tr></thead><tbody>';
            data.fetchers.forEach(s => {
                const name = s.name.replace('fetch_', '').replace('.py', '').replace(/_/g, ' ');
                const label = name.charAt(0).toUpperCase() + name.slice(1);
                html += `<tr>
                    <td><code>${escapeHtml(s.name)}</code><br><span class="text-muted text-xs">${label}</span></td>
                    <td class="text-muted">${escapeHtml(s.description || '-')}</td>
                    <td>${formatSize(s.size)}</td>
                    <td>
                        <button class="btn btn-sm btn-green" onclick="runScript('${s.name}')">Run</button>
                        <button class="btn btn-sm" onclick="viewScriptSource('${s.path}')">View</button>
                    </td>
                </tr>`;
            });
            html += '</tbody></table>';
            fetcherContainer.innerHTML = html;
        }

        // Analysis
        const analysisContainer = document.getElementById('analysis-list');
        if (data.analysis.length === 0) {
            analysisContainer.innerHTML = '<div class="empty-state"><p>No analysis scripts found.</p></div>';
        } else {
            let html = '<table><thead><tr><th>Script</th><th>Description</th><th>Size</th><th></th></tr></thead><tbody>';
            data.analysis.forEach(s => {
                html += `<tr>
                    <td><code>${escapeHtml(s.name)}</code></td>
                    <td class="text-muted">${escapeHtml(s.description || '-')}</td>
                    <td>${formatSize(s.size)}</td>
                    <td>
                        <button class="btn btn-sm btn-green" onclick="runScript('${s.name}')">Run</button>
                        <button class="btn btn-sm" onclick="viewScriptSource('${s.path}')">View</button>
                    </td>
                </tr>`;
            });
            html += '</tbody></table>';
            analysisContainer.innerHTML = html;
        }
    } catch (e) {
        console.error('Failed to load scripts:', e);
    }
}

async function runScript(scriptName) {
    const card = document.getElementById('script-output-card');
    const terminal = document.getElementById('script-terminal');
    const status = document.getElementById('script-run-status');

    card.style.display = '';
    terminal.innerHTML = `<span class="line-status">Running ${escapeHtml(scriptName)}...</span>\n`;
    status.className = 'tag tag-yellow';
    status.textContent = 'Running';

    try {
        const result = await api('/api/scripts/run', {
            method: 'POST',
            body: JSON.stringify({ script: scriptName }),
        });

        const runId = result.run_id;

        // Poll for completion
        const poll = async () => {
            const info = await api(`/api/scripts/status/${runId}`);
            if (info.status === 'running') {
                setTimeout(poll, 1000);
                return;
            }

            if (info.status === 'completed') {
                status.className = 'tag tag-green';
                status.textContent = 'Completed';
                terminal.innerHTML = '';
                if (info.stdout) {
                    terminal.innerHTML += `<span class="line-stdout">${escapeHtml(info.stdout)}</span>`;
                }
                if (info.stderr) {
                    terminal.innerHTML += `\n<span class="line-stderr">${escapeHtml(info.stderr)}</span>`;
                }
                if (!info.stdout && !info.stderr) {
                    terminal.innerHTML = '<span class="line-complete">Script completed with no output.</span>';
                }
            } else if (info.status === 'failed') {
                status.className = 'tag tag-red';
                status.textContent = 'Failed';
                terminal.innerHTML = `<span class="line-error">Exit code: ${info.returncode}</span>\n`;
                if (info.stdout) terminal.innerHTML += `<span class="line-stdout">${escapeHtml(info.stdout)}</span>\n`;
                if (info.stderr) terminal.innerHTML += `<span class="line-stderr">${escapeHtml(info.stderr)}</span>`;
            } else if (info.status === 'timeout') {
                status.className = 'tag tag-red';
                status.textContent = 'Timeout';
                terminal.innerHTML = '<span class="line-error">Script timed out after 5 minutes.</span>';
            } else {
                status.className = 'tag tag-red';
                status.textContent = 'Error';
                terminal.innerHTML = `<span class="line-error">${escapeHtml(info.error || 'Unknown error')}</span>`;
            }
        };

        setTimeout(poll, 1000);
    } catch (e) {
        status.className = 'tag tag-red';
        status.textContent = 'Error';
        terminal.innerHTML = `<span class="line-error">${escapeHtml(String(e))}</span>`;
    }
}

function viewScriptSource(path) {
    navigateTo('files');
    setTimeout(() => loadFiles(path), 100);
}

// ---------------------------------------------------------------------------
// File Browser
// ---------------------------------------------------------------------------
let currentFilePath = '';

async function loadFiles(path) {
    currentFilePath = path;
    const listing = document.getElementById('file-listing');
    const contentCard = document.getElementById('file-content-card');

    listing.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';

    try {
        const data = await api(`/api/files?path=${encodeURIComponent(path)}`);

        // Breadcrumb
        const bc = document.getElementById('file-breadcrumb');
        const parts = path ? path.split('/') : [];
        let bcHtml = `<a onclick="loadFiles('')">workspace</a>`;
        let accumulated = '';
        parts.forEach((part, i) => {
            accumulated += (accumulated ? '/' : '') + part;
            const p = accumulated;
            if (i === parts.length - 1) {
                bcHtml += ` <span>/</span> <span>${escapeHtml(part)}</span>`;
            } else {
                bcHtml += ` <span>/</span> <a onclick="loadFiles('${p}')">${escapeHtml(part)}</a>`;
            }
        });
        bc.innerHTML = bcHtml;

        if (data.type === 'directory') {
            contentCard.style.display = 'none';
            if (data.entries.length === 0) {
                listing.innerHTML = '<div class="empty-state"><p>Empty directory</p></div>';
            } else {
                let html = '';
                // Add parent dir link
                if (path) {
                    const parent = path.split('/').slice(0, -1).join('/');
                    html += `<div class="file-item" onclick="loadFiles('${parent}')">
                        <span class="file-icon dir">&#128194;</span>
                        <span class="file-name">..</span>
                        <span class="file-size"></span>
                    </div>`;
                }
                data.entries.forEach(e => {
                    const icon = e.is_dir ? '<span class="file-icon dir">&#128194;</span>' : '<span class="file-icon">&#128196;</span>';
                    const size = e.is_dir ? '' : formatSize(e.size);
                    html += `<div class="file-item" onclick="loadFiles('${e.path}')">
                        ${icon}
                        <span class="file-name">${escapeHtml(e.name)}</span>
                        <span class="file-size">${size}</span>
                    </div>`;
                });
                listing.innerHTML = html;
            }
        } else if (data.type === 'file') {
            listing.innerHTML = '';
            contentCard.style.display = '';
            document.getElementById('file-content-title').textContent = data.name;
            document.getElementById('file-content-size').textContent = formatSize(data.size);
            document.getElementById('file-content-pre').textContent = data.content;

            // Re-render breadcrumb for parent dir navigation
            const parentPath = path.split('/').slice(0, -1).join('/');
            loadFileParent(parentPath);
        }
    } catch (e) {
        listing.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(String(e))}</p></div>`;
    }
}

async function loadFileParent(parentPath) {
    try {
        const data = await api(`/api/files?path=${encodeURIComponent(parentPath)}`);
        const listing = document.getElementById('file-listing');
        if (data.type === 'directory') {
            let html = '';
            if (parentPath) {
                const grandparent = parentPath.split('/').slice(0, -1).join('/');
                html += `<div class="file-item" onclick="loadFiles('${grandparent}')">
                    <span class="file-icon dir">&#128194;</span>
                    <span class="file-name">..</span>
                </div>`;
            }
            data.entries.forEach(e => {
                const icon = e.is_dir ? '<span class="file-icon dir">&#128194;</span>' : '<span class="file-icon">&#128196;</span>';
                const size = e.is_dir ? '' : formatSize(e.size);
                const active = e.path === currentFilePath ? 'style="background: var(--bg-hover)"' : '';
                html += `<div class="file-item" ${active} onclick="loadFiles('${e.path}')">
                    ${icon}
                    <span class="file-name">${escapeHtml(e.name)}</span>
                    <span class="file-size">${size}</span>
                </div>`;
            });
            listing.innerHTML = html;
        }
    } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Wiki
// ---------------------------------------------------------------------------
async function loadWiki() {
    try {
        const data = await api('/api/wiki');
        const container = document.getElementById('wiki-list');

        if (!data.pages || data.pages.length === 0) {
            container.innerHTML = '<div class="empty-state"><p>No wiki pages found.</p></div>';
            return;
        }

        let html = '';
        data.pages.forEach(p => {
            html += `<div class="file-item" onclick="viewWikiPage('${p.path}', '${escapeHtml(p.name)}')">
                <span class="file-icon">&#128214;</span>
                <span class="file-name">${escapeHtml(p.name)}</span>
                <span class="file-size">${formatSize(p.size)}</span>
            </div>`;
        });
        container.innerHTML = html;
    } catch (e) {
        console.error('Failed to load wiki:', e);
    }
}

async function viewWikiPage(path, name) {
    document.getElementById('wiki-page-title').textContent = name;
    const container = document.getElementById('wiki-content');
    container.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';

    try {
        const data = await api(`/api/wiki/${path}`);
        // Simple markdown-to-html (basic rendering)
        const rendered = renderMarkdown(data.content);
        container.innerHTML = `<div style="line-height: 1.7; font-size: 14px;">${rendered}</div>`;
    } catch (e) {
        container.innerHTML = `<div class="empty-state"><p>Error: ${escapeHtml(String(e))}</p></div>`;
    }
}

function renderMarkdown(text) {
    // Very basic markdown renderer
    let html = escapeHtml(text);
    // Headers
    html = html.replace(/^### (.+)$/gm, '<h4 style="margin: 16px 0 8px; color: var(--text-primary);">$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3 style="margin: 20px 0 8px; color: var(--text-primary);">$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2 style="margin: 24px 0 10px; color: var(--text-primary);">$1</h2>');
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Inline code
    html = html.replace(/`(.+?)`/g, '<code>$1</code>');
    // Code blocks
    html = html.replace(/```[\s\S]*?```/g, (match) => {
        const code = match.replace(/```\w*\n?/, '').replace(/```$/, '');
        return `<pre>${code}</pre>`;
    });
    // Lists
    html = html.replace(/^- (.+)$/gm, '<li style="margin-left: 20px;">$1</li>');
    // Line breaks
    html = html.replace(/\n\n/g, '<br><br>');
    html = html.replace(/\n/g, '<br>');
    return html;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
async function loadConfig() {
    try {
        const data = await api('/api/config');

        // Credentials
        const credContainer = document.getElementById('config-credentials');
        let credHtml = '';
        const providers = [
            ['OpenAI', data.credentials.openai],
            ['Anthropic', data.credentials.anthropic],
            ['OpenRouter', data.credentials.openrouter],
            ['Cerebras', data.credentials.cerebras],
            ['Exa (Search)', data.credentials.exa],
            ['Voyage', data.credentials.voyage],
        ];
        providers.forEach(([name, key]) => {
            const configured = !!key;
            credHtml += `<div class="key-status" style="margin-bottom: 10px;">
                <span class="key-dot ${configured ? 'configured' : 'missing'}"></span>
                <span style="width: 120px; font-size: 13px;">${name}</span>
                <code class="text-muted text-xs">${key || 'Not configured'}</code>
            </div>`;
        });
        credHtml += `<p class="text-muted text-xs mt-2">Keys are loaded from environment variables, .env files, or credential stores. Use <code>openplanter-agent --configure-keys</code> to set them.</p>`;
        credContainer.innerHTML = credHtml;

        // Agent config
        const agentContainer = document.getElementById('config-agent');
        const cfg = data.agent_config;
        let agentHtml = '<table>';
        const configItems = [
            ['Provider', cfg.provider],
            ['Model', cfg.model],
            ['Reasoning Effort', cfg.reasoning_effort || 'default'],
            ['Max Depth', cfg.max_depth],
            ['Max Steps/Call', cfg.max_steps_per_call],
            ['Max Observation Chars', cfg.max_observation_chars],
            ['Command Timeout', cfg.command_timeout_sec + 's'],
            ['Recursive', cfg.recursive ? 'Yes' : 'No'],
            ['Acceptance Criteria', cfg.acceptance_criteria ? 'Yes' : 'No'],
            ['Demo Mode', cfg.demo ? 'Yes' : 'No'],
        ];
        configItems.forEach(([label, value]) => {
            agentHtml += `<tr><td class="text-muted" style="padding: 5px 14px 5px 0; width: 160px;">${label}</td><td style="padding: 5px 0;"><code>${escapeHtml(String(value))}</code></td></tr>`;
        });
        agentHtml += '</table>';
        agentContainer.innerHTML = agentHtml;

        // Settings
        const settingsContainer = document.getElementById('config-settings');
        const settings = data.settings;
        const defaults = data.provider_defaults;
        let settingsHtml = `
            <div class="grid grid-2">
                <div class="form-group">
                    <label>Default Model</label>
                    <input class="form-input" id="cfg-default-model" value="${escapeHtml(settings.default_model || '')}" placeholder="e.g. claude-opus-4-6">
                </div>
                <div class="form-group">
                    <label>Default Reasoning Effort</label>
                    <select class="form-select" id="cfg-default-reasoning">
                        <option value="">Not set</option>
                        <option value="high" ${settings.default_reasoning_effort === 'high' ? 'selected' : ''}>High</option>
                        <option value="medium" ${settings.default_reasoning_effort === 'medium' ? 'selected' : ''}>Medium</option>
                        <option value="low" ${settings.default_reasoning_effort === 'low' ? 'selected' : ''}>Low</option>
                    </select>
                </div>
            </div>
            <p class="text-xs text-muted mb-2">Provider-specific default models:</p>
            <div class="grid grid-2">`;
        ['openai', 'anthropic', 'openrouter', 'cerebras', 'ollama'].forEach(prov => {
            const key = `default_model_${prov}`;
            const val = settings[key] || '';
            const placeholder = defaults[prov] || '';
            settingsHtml += `
                <div class="form-group">
                    <label>${prov.charAt(0).toUpperCase() + prov.slice(1)} Model</label>
                    <input class="form-input" id="cfg-${key}" value="${escapeHtml(val)}" placeholder="${escapeHtml(placeholder)}">
                </div>`;
        });
        settingsHtml += '</div>';
        settingsContainer.innerHTML = settingsHtml;
    } catch (e) {
        console.error('Failed to load config:', e);
    }
}

async function saveSettings() {
    const body = {
        default_model: document.getElementById('cfg-default-model')?.value || null,
        default_reasoning_effort: document.getElementById('cfg-default-reasoning')?.value || null,
        default_model_openai: document.getElementById('cfg-default_model_openai')?.value || null,
        default_model_anthropic: document.getElementById('cfg-default_model_anthropic')?.value || null,
        default_model_openrouter: document.getElementById('cfg-default_model_openrouter')?.value || null,
        default_model_cerebras: document.getElementById('cfg-default_model_cerebras')?.value || null,
        default_model_ollama: document.getElementById('cfg-default_model_ollama')?.value || null,
    };

    try {
        await api('/api/config/settings', {
            method: 'POST',
            body: JSON.stringify(body),
        });
        alert('Settings saved successfully.');
    } catch (e) {
        alert('Error saving settings: ' + e);
    }
}

// ---------------------------------------------------------------------------
// Investigation / Agent Execution
// ---------------------------------------------------------------------------
let activeWs = null;

function launchInvestigation() {
    const objective = document.getElementById('inv-objective').value.trim();
    if (!objective) {
        alert('Please enter an investigation objective.');
        return;
    }

    const terminal = document.getElementById('inv-terminal');
    const status = document.getElementById('inv-status');
    const launchBtn = document.getElementById('inv-launch');

    // Close existing connection
    if (activeWs) {
        activeWs.close();
        activeWs = null;
    }

    terminal.innerHTML = '';
    status.className = 'tag tag-yellow';
    status.textContent = 'Connecting...';
    launchBtn.disabled = true;

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws/agent`);
    activeWs = ws;

    ws.onopen = () => {
        status.className = 'tag tag-green';
        status.textContent = 'Running';

        ws.send(JSON.stringify({
            objective: objective,
            provider: document.getElementById('inv-provider').value,
            model: document.getElementById('inv-model').value,
            max_steps: parseInt(document.getElementById('inv-max-steps').value) || 100,
            max_depth: parseInt(document.getElementById('inv-max-depth').value) || 4,
            reasoning_effort: document.getElementById('inv-reasoning').value,
        }));
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        const line = document.createElement('div');

        switch (data.type) {
            case 'stdout':
                line.className = 'line-stdout';
                line.textContent = data.message;
                break;
            case 'stderr':
                line.className = 'line-stderr';
                line.textContent = data.message;
                break;
            case 'status':
                line.className = 'line-status';
                line.textContent = data.message;
                break;
            case 'error':
                line.className = 'line-error';
                line.textContent = 'ERROR: ' + data.message;
                status.className = 'tag tag-red';
                status.textContent = 'Error';
                break;
            case 'complete':
                line.className = 'line-complete';
                line.textContent = data.message;
                status.className = data.returncode === 0 ? 'tag tag-green' : 'tag tag-red';
                status.textContent = data.returncode === 0 ? 'Completed' : 'Failed';
                launchBtn.disabled = false;
                break;
            default:
                line.className = 'line-stdout';
                line.textContent = data.message || JSON.stringify(data);
        }

        terminal.appendChild(line);
        terminal.scrollTop = terminal.scrollHeight;
    };

    ws.onerror = () => {
        status.className = 'tag tag-red';
        status.textContent = 'Connection Error';
        launchBtn.disabled = false;
    };

    ws.onclose = () => {
        if (status.textContent === 'Running') {
            status.className = 'tag tag-yellow';
            status.textContent = 'Disconnected';
        }
        launchBtn.disabled = false;
        activeWs = null;
    };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
loadOverview();
