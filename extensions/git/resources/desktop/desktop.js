/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
(() => {
	const vscode = acquireVsCodeApi();
	const labels = window.desktopLabels;
	const t = key => labels[key] || key;
	const saved = vscode.getState() || {};
	let state, activeTab = 'changes', popup, filter = '', branchFilter = '', history = [], historyRef, historyFiles = [], currentFile, diff = '', diffRequest = 0, error = '', loading = false;
	let selections = new Set(), excluded = new Set(), drafts = saved.drafts || {}, lastRepository;
	const root = document.getElementById('app');
	const compact = document.body.classList.contains('compact');
	function send(command, data = {}) { vscode.postMessage({ command, repository: state?.selected, ...data }); }
	function element(tag, cls, text) {
		const node = document.createElement(tag);
		if (cls) { node.className = cls; }
		if (text !== undefined) { node.textContent = text; }
		return node;
	}
	function button(label, action, cls = '', disabled = false) {
		const node = element('button', cls, t(label)); node.type = 'button'; node.disabled = disabled;
		node.addEventListener('click', action); return node;
	}
	function persist() { vscode.setState({ drafts }); }
	function currentDraft() { return drafts[state?.selected] || (drafts[state?.selected] = { summary: '', description: '' }); }
	function chooseFile(file, historic = false) {
		currentFile = file; diff = ''; loading = true; error = ''; diffRequest++;
		send(historic ? 'historyDiff' : 'diff', { path: file.id, ref: historyRef, request: diffRequest }); render();
	}
	function chooseCommit(commit) {
		historyRef = commit.hash; historyFiles = []; currentFile = undefined; diff = ''; loading = true;
		send('commitDetails', { ref: historyRef }); render();
	}
	function render() {
		const focused = document.activeElement;
		const focusId = focused?.id;
		const selectionStart = focused?.selectionStart, selectionEnd = focused?.selectionEnd;
		root.replaceChildren();
		if (!state) { root.append(element('div', 'empty', t('Working') + '…')); return; }
		const top = element('header', 'topbar');
		const repo = state.repositories.find(repo => repo.id === state.selected);
		const repositoryButton = button('', () => { popup = popup === 'repositories' ? undefined : 'repositories'; render(); }, 'top-control repository');
		repositoryButton.append(element('span', 'top-label', t('Current Repository')), element('strong', '', repo?.name || t('No Git Repository')), element('span', 'chevron', '⌄'));
		repositoryButton.setAttribute('aria-label', t('Current Repository')); repositoryButton.setAttribute('aria-expanded', popup === 'repositories'); top.append(repositoryButton);
		if (repo) {
			const branchButton = button('', () => { popup = popup === 'branches' ? undefined : 'branches'; render(); }, 'top-control branch', state.busy);
			branchButton.append(element('span', 'top-label', t('Current Branch')), element('strong', '', state.branch || '—'), element('span', 'chevron', '⌄'));
			branchButton.setAttribute('aria-label', t('Current Branch')); branchButton.setAttribute('aria-expanded', popup === 'branches'); top.append(branchButton);
			const remoteAction = !state.upstream && state.branch ? 'push' : state.behind ? 'pull' : state.ahead ? 'push' : 'fetch';
			const remoteLabel = !state.upstream && state.branch ? 'Publish Branch' : state.behind ? 'Pull Origin' : state.ahead ? 'Push Origin' : 'Fetch Origin';
			const remoteButton = button('', () => send(remoteAction), 'top-control remote', state.busy || !state.remotes.length);
			remoteButton.append(element('strong', '', state.busy ? t('Working') + '…' : t(remoteLabel)), element('span', 'top-label', [state.ahead ? `${state.ahead} ↑` : '', state.behind ? `${state.behind} ↓` : '', state.fetched ? new Date(state.fetched).toLocaleTimeString() : state.remotes.join(', ')].filter(Boolean).join(' · ')));
			top.append(remoteButton);
		}
		root.append(top);
		if (popup) { renderPopup(repo); }
		if (error) { const banner = element('div', 'error'); banner.setAttribute('role', 'alert'); banner.append(element('span', '', error), button('Close', () => { error = ''; render(); })); root.append(banner); }
		if (!repo) {
			const empty = element('section', 'empty'); empty.append(element('h2', '', t('No Git Repository')), element('p', '', t('Open or Clone a Repository to Get Started')), button('Add Repository', () => send('addRepository'), 'primary'), button('Clone Repository', () => send('clone')), button('Initialize Repository', () => send('init'))); root.append(empty); return;
		}
		if (compact) { renderCompact(); return; }
		const layout = element('main', 'layout');
		const sidebar = element('aside', 'sidebar');
		const tabs = element('div', 'tabs'); tabs.setAttribute('role', 'tablist');
		for (const [key, label] of [['changes', 'Changes'], ['history', 'History']]) {
			const tab = button(label, () => {
				activeTab = key; currentFile = undefined; diff = ''; historyRef = undefined; loading = false;
				if (key === 'history') { send('history', { request: 0 }); } render();
			}, activeTab === key ? 'active' : '');
			tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', activeTab === key); tabs.append(tab);
		}
		sidebar.append(tabs);
		const input = element('input', 'filter'); input.id = 'file-filter'; input.placeholder = t('Filter'); input.setAttribute('aria-label', t('Filter')); input.value = filter;
		input.addEventListener('input', () => { filter = input.value; render(); }); sidebar.append(input);
		const list = element('div', 'file-list'); list.setAttribute('aria-label', t(activeTab === 'changes' ? 'Changed Files' : 'History'));
		if (activeTab === 'changes') {
			const selectAll = element('label', 'select-all'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', t('Select All'));
			checkbox.checked = state.changes.length > 0 && state.changes.every(file => selections.has(file.id)); checkbox.indeterminate = selections.size > 0 && !checkbox.checked;
			checkbox.addEventListener('change', () => {
				excluded = checkbox.checked ? new Set() : new Set(state.changes.map(file => file.id)); selections = checkbox.checked ? new Set(state.changes.map(file => file.id)) : new Set(); render();
			}); selectAll.append(checkbox, element('span', '', `${state.changes.length} ${t('Changed Files')}`)); sidebar.append(selectAll);
			for (const file of state.changes.filter(file => file.path.toLowerCase().includes(filter.toLowerCase()))) { list.append(fileRow(file)); }
			if (!state.changes.length) { list.append(element('div', 'list-empty', t('No Local Changes'))); }
			sidebar.append(list); renderCommit(sidebar);
		} else {
			for (const commit of history.filter(commit => (commit.message + commit.authorName).toLowerCase().includes(filter.toLowerCase()))) {
				const row = button('', () => chooseCommit(commit), 'history-row' + (historyRef === commit.hash ? ' selected' : ''));
				row.append(element('strong', '', commit.message.split('\n')[0]), element('span', 'muted', [commit.authorName, commit.hash.slice(0, 7), commit.authorDate ? new Date(commit.authorDate).toLocaleDateString() : ''].filter(Boolean).join(' · '))); list.append(row);
			}
			if (!history.length) { list.append(element('div', 'list-empty', t('No Commits Yet'))); }
			if (history.length && history.length % 100 === 0) { list.append(button('Load More', () => send('history', { request: history.length }))); }
			sidebar.append(list);
		}
		const detail = element('section', 'detail');
		const tools = element('div', 'tools');
		tools.append(button('Refresh', () => send('refresh'), '', state.busy), button('Fetch Origin', () => send('fetch'), '', state.busy || !state.remotes.length), button('View on GitHub', () => send('github')), button('Pull Requests', () => send('pullRequests')), button('Create Pull Request', () => send('createPullRequest'), '', !state.upstream)); if (!state.remotes.length) { tools.append(button('Add Remote', () => send('addRemote'), '', state.busy)); } detail.append(tools);
		if (state.conflicts) { detail.append(element('div', 'warning', `${state.conflicts} ${t('Conflicts')} · ${t('Resolve Conflicts Before Committing')}`)); }
		if (activeTab === 'history' && historyRef) {
			const commit = history.find(commit => commit.hash === historyRef);
			const summary = element('div', 'commit-details'); summary.append(element('h2', '', commit?.message.split('\n')[0]), element('p', 'muted', `${commit?.authorName || ''} · ${historyRef.slice(0, 7)}`), element('p', 'commit-description', commit?.message.split('\n').slice(1).join('\n'))); detail.append(summary);
			const files = element('div', 'history-files'); for (const file of historyFiles) { files.append(button(file.path, () => chooseFile(file, true), 'history-file' + (currentFile?.id === file.id ? ' selected' : ''))); } detail.append(files);
		}
		if (currentFile) {
			const header = element('div', 'diff-header'); header.append(element('strong', '', currentFile.path));
			if (activeTab === 'changes') { header.append(button('Open in Editor', () => send('openFile', { path: currentFile.id }))); if (currentFile.staged) { header.append(button('Unstage File', () => send('unstage', { path: currentFile.id }), '', state.busy)); } if (currentFile.conflict) { header.append(button('Mark Resolved', () => send('stage', { path: currentFile.id }), '', state.busy)); } } detail.append(header);
			const code = element('div', 'diff'); code.setAttribute('aria-label', currentFile.path); code.tabIndex = 0;
			if (loading) { code.append(element('div', 'list-empty', t('Working') + '…')); }
			else if (!diff) { code.append(element('div', 'list-empty', t('Binary File or No Text Changes'))); }
			else {
				let oldLine = 0, newLine = 0;
				for (const line of diff.split('\n')) {
					const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
					if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); }
					const add = line.startsWith('+') && !line.startsWith('+++'), remove = line.startsWith('-') && !line.startsWith('---');
					const meta = hunk || /^(diff |index |--- |\+\+\+ |new file|deleted file|rename |similarity |Binary |\\)/.test(line);
					const row = element('div', 'diff-line' + (add ? ' addition' : remove ? ' deletion' : meta ? ' hunk' : ''));
					row.append(element('span', 'line-number', meta || add ? '' : String(oldLine || '')), element('span', 'line-number', meta || remove ? '' : String(newLine || '')), element('span', 'line-text', line)); code.append(row);
					if (!meta) { if (!add) { oldLine++; } if (!remove) { newLine++; } }
				}
			} detail.append(code);
		} else if (!(activeTab === 'history' && historyRef)) {
			const empty = element('div', 'empty'); empty.append(element('div', 'empty-icon', '⑂'), element('h2', '', t(state.changes.length ? 'Select a File to Review Its Changes' : 'No Local Changes')), element('p', 'muted', t(state.changes.length ? 'Changes' : 'Your Working Tree Is Clean'))); detail.append(empty);
		}
		layout.append(sidebar, detail); root.append(layout);
		if (focusId) { const next = document.getElementById(focusId); if (next) { next.focus(); if (selectionStart !== undefined && next.setSelectionRange) { next.setSelectionRange(selectionStart, selectionEnd); } } }
	}
	function fileRow(file) {
		const row = element('div', 'file-row' + (currentFile?.id === file.id ? ' selected' : ''));
		const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = selections.has(file.id); checkbox.setAttribute('aria-label', file.path);
		checkbox.addEventListener('change', () => { if (checkbox.checked) { selections.add(file.id); excluded.delete(file.id); } else { selections.delete(file.id); excluded.add(file.id); } render(); });
		const select = button('', () => chooseFile(file), 'file-name'); select.title = file.path;
		select.append(element('span', 'file-path', file.path), element('span', 'status' + (file.conflict ? ' conflict' : ''), file.conflict ? '!' : [1, 7, 9].includes(file.status) ? 'A' : [2, 6].includes(file.status) ? 'D' : [3, 10].includes(file.status) ? 'R' : 'M'));
		row.append(checkbox, select); return row;
	}
	function renderCommit(sidebar) {
		const form = element('form', 'commit-form');
		const draft = currentDraft();
		const summary = element('input'); summary.id = 'commit-summary'; summary.placeholder = t('Summary (Required)'); summary.setAttribute('aria-label', t('Summary (Required)')); summary.value = draft.summary;
		const description = element('textarea'); description.id = 'commit-description'; description.placeholder = t('Description'); description.setAttribute('aria-label', t('Description')); description.value = draft.description;
		const submit = element('button', 'primary commit-button', `${t('Commit to')} ${state.branch || 'HEAD'}`); submit.type = 'submit';
		const update = () => { submit.disabled = !summary.value.trim() || !selections.size || state.busy || !!state.conflicts; };
		summary.addEventListener('input', () => { draft.summary = summary.value; persist(); update(); }); description.addEventListener('input', () => { draft.description = description.value; persist(); }); update();
		form.addEventListener('submit', event => { event.preventDefault(); if (!submit.disabled) { send('commit', { summary: summary.value, description: description.value, paths: [...selections] }); } });
		form.append(summary, description, element('span', 'muted selected-count', `${selections.size} / ${state.changes.length} ${t('Files')}`), submit); sidebar.append(form);
	}
	function renderCompact() {
		const main = element('main', 'compact-main'); main.append(button('Open Git Desktop', () => send('open'), 'primary'));
		main.append(element('h3', '', `${state.changes.length} ${t('Changed Files')}`));
		const list = element('div', 'compact-files');
		for (const file of state.changes) { list.append(button(file.path, () => { send('open'); send('openFile', { path: file.id }); }, 'compact-file')); }
		if (!state.changes.length) { list.append(element('p', 'muted', t('Your Working Tree Is Clean'))); }
		main.append(list, button('Refresh', () => send('refresh'), '', state.busy)); root.append(main);
	}
	function renderPopup(repo) {
		const overlay = element('div', 'popup ' + popup); overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', t(popup === 'branches' ? 'Current Branch' : 'Current Repository'));
		const top = element('div', 'popup-tools'); top.append(element('strong', '', t(popup === 'branches' ? 'Current Branch' : 'Current Repository')), button('Close', () => { popup = undefined; render(); })); overlay.append(top);
		if (popup === 'repositories') {
			for (const repository of state.repositories) {
				const row = button('', () => { send('selectRepository', { repository: repository.id }); popup = undefined; }, 'repo-row' + (repository.id === state.selected ? ' selected' : ''));
				row.append(element('strong', '', repository.name), element('span', 'muted', repository.path)); overlay.append(row);
			}
			overlay.append(button('Add Repository', () => send('addRepository')), button('Clone Repository', () => send('clone')));
		} else if (repo) {
			const search = element('input', 'filter'); search.id = 'branch-filter'; search.placeholder = t('Filter'); search.setAttribute('aria-label', t('Branch') + ' ' + t('Filter')); search.value = branchFilter; search.addEventListener('input', () => { branchFilter = search.value; render(); }); overlay.append(search);
			overlay.append(button('New Branch', () => { popup = undefined; send('newBranch'); render(); }, 'primary', state.busy));
			const list = element('div', 'branch-list');
			for (const remote of [false, true]) {
				list.append(element('h3', '', t(remote ? 'Remote Branches' : 'Local Branches')));
				for (const branch of state.branches.filter(branch => branch.remote === remote && branch.name.toLowerCase().includes(branchFilter.toLowerCase())).slice(0, 150)) {
					const row = button((branch.name === state.branch ? '✓ ' : '⑂ ') + branch.name, () => { popup = undefined; send('checkout', { ref: branch.name }); render(); }, 'branch-row' + (branch.name === state.branch ? ' selected' : ''), state.busy); list.append(row);
				}
			}
			overlay.append(list, button('Undo Last Commit', () => { popup = undefined; send('undo'); render(); }, '', state.busy || !!state.upstream && !state.ahead), button('Merge Into Current Branch', () => { popup = undefined; send('merge'); render(); }, '', state.busy), button('Stash Changes', () => send('stash'), '', state.busy || !state.changes.length), button('Restore Stash', () => send('restoreStash'), '', state.busy));
		}
		root.append(overlay);
	}
	window.addEventListener('message', ({ data }) => {
		if (data.type === 'state') {
			const previous = state;
			state = data;
			if (lastRepository !== state.selected) {
				lastRepository = state.selected; selections = new Set(); excluded = new Set(); currentFile = undefined; history = []; historyFiles = []; historyRef = undefined; diff = ''; error = ''; loading = false; diffRequest++;
				if (activeTab === 'history' && state.selected) { send('history', { request: 0 }); }
			}
			selections = new Set(state.changes.filter(file => !excluded.has(file.id)).map(file => file.id));
			if (currentFile && activeTab === 'changes') {
				if (!state.changes.some(file => file.id === currentFile.id)) { currentFile = undefined; diff = ''; diffRequest++; }
				else if (!state.busy) { currentFile = state.changes.find(file => file.id === currentFile.id); loading = true; diffRequest++; send('diff', { path: currentFile.id, request: diffRequest }); }
			}
			if (previous?.busy && !state.busy && activeTab === 'history') { send('history', { request: 0 }); }
		} else if (data.type === 'error') { error = data.message; loading = false; }
		else if (data.repository !== state?.selected) { return; }
		else if (data.type === 'diff') { if (data.request !== diffRequest || data.id !== currentFile?.id) { return; } diff = data.text; loading = false; }
		else if (data.type === 'history') { if (activeTab !== 'history') { return; } history = data.skip ? [...history, ...data.commits] : data.commits; }
		else if (data.type === 'commitDetails') { if (data.ref !== historyRef) { return; } historyFiles = data.files; loading = false; if (historyFiles[0]) { chooseFile(historyFiles[0], true); return; } }
		else if (data.type === 'committed') { drafts[state.selected] = { summary: '', description: '' }; persist(); excluded.clear(); currentFile = undefined; diff = ''; error = ''; }
		render();
	});
	document.addEventListener('keydown', event => { if (event.key === 'Escape' && popup) { popup = undefined; render(); } });
	send('ready'); render();
})();
