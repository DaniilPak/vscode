/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commands, Disposable, env, ExtensionContext, l10n, Uri, ViewColumn, Webview, WebviewPanel, WebviewView, WebviewViewProvider, window, workspace } from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { API, Change, Repository } from './api/git';
import { RefType, Status } from './api/git.constants';
import { checkoutDesktopBranch, commitDesktopChanges, desktopChanges } from './desktopOperations';

interface DesktopMessage {
	command: string;
	repository?: string;
	path?: string;
	ref?: string;
	paths?: string[];
	summary?: string;
	description?: string;
	request?: number;
}

/** A Desktop-style Git workspace backed by the existing Git operation queue. */
export class DesktopGit implements WebviewViewProvider, Disposable {
	private readonly disposables: Disposable[] = [];
	private readonly repositoryListeners = new Map<string, Disposable>();
	private readonly surfaces = new Set<Webview>();
	private readonly surfaceDisposables = new Set<Disposable>();
	private panel: WebviewPanel | undefined;
	private selected: string | undefined;
	private revision = 0;
	private busy = false;
	private fetched = new Map<string, string>();

	constructor(private readonly context: ExtensionContext, private readonly api: API) {
		this.disposables.push(
			commands.registerCommand('git.desktop.open', async (root?: Uri) => {
				if (root instanceof Uri && this.api.repositories.some(repository => repository.rootUri.toString() === root.toString())) { this.selected = root.toString(); }
				await this.open();
				await this.refresh();
			}),
			window.registerWebviewViewProvider('git.desktop', this, { webviewOptions: { retainContextWhenHidden: true } }),
			window.registerWebviewPanelSerializer('git.desktop.workspace', {
				deserializeWebviewPanel: async panel => { this.adoptPanel(panel); }
			}),
			api.onDidOpenRepository(repository => { this.listen(repository); void this.refresh(); }),
			api.onDidCloseRepository(repository => {
				this.repositoryListeners.get(repository.rootUri.toString())?.dispose();
				this.repositoryListeners.delete(repository.rootUri.toString());
				void this.refresh();
			})
		);
		for (const repository of api.repositories) { this.listen(repository); }
	}

	private listen(repository: Repository): void {
		const key = repository.rootUri.toString();
		if (!this.repositoryListeners.has(key)) {
			this.repositoryListeners.set(key, repository.state.onDidChange(() => { void this.refresh(); }));
		}
	}

	resolveWebviewView(view: WebviewView): void {
		const listeners = this.attach(view.webview, true);
		listeners.push(view.onDidDispose(() => Disposable.from(...listeners).dispose()));
	}

	private async open(): Promise<void> {
		await commands.executeCommand('workbench.action.closeSidebar');
		if (this.panel) { this.panel.reveal(); return; }
		this.adoptPanel(window.createWebviewPanel('git.desktop.workspace', l10n.t('Git Desktop'), ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true }));
	}

	private adoptPanel(panel: WebviewPanel): void {
		this.panel = panel;
		panel.iconPath = Uri.joinPath(this.context.extensionUri, 'resources', 'icons', 'git.png');
		const listeners = this.attach(panel.webview, false);
		listeners.push(panel.onDidDispose(() => { this.panel = undefined; Disposable.from(...listeners).dispose(); }));
	}

	private attach(webview: Webview, compact: boolean): Disposable[] {
		const root = Uri.joinPath(this.context.extensionUri, 'resources', 'desktop');
		webview.options = { enableScripts: true, localResourceRoots: [root] };
		const nonce = randomBytes(24).toString('hex');
		const css = webview.asWebviewUri(Uri.joinPath(root, 'desktop.css'));
		const js = webview.asWebviewUri(Uri.joinPath(root, 'desktop.js'));
		// Repository-controlled content is always rendered with textContent in desktop.js.
		const labels = JSON.stringify({
			'Current Repository': l10n.t('Current Repository'),
			'Current Branch': l10n.t('Current Branch'),
			'Fetch Origin': l10n.t('Fetch Origin'),
			'Pull Origin': l10n.t('Pull Origin'),
			'Push Origin': l10n.t('Push Origin'),
			'Publish Branch': l10n.t('Publish Branch'),
			'Changes': l10n.t('Changes'),
			'History': l10n.t('History'),
			'Filter': l10n.t('Filter'),
			'New Branch': l10n.t('New Branch'),
			'Merge Into Current Branch': l10n.t('Merge Into Current Branch'),
			'Local Branches': l10n.t('Local Branches'),
			'Remote Branches': l10n.t('Remote Branches'),
			'Summary (Required)': l10n.t('Summary (Required)'),
			'Description': l10n.t('Description'),
			'Commit to': l10n.t('Commit to'),
			'Changed Files': l10n.t('Changed Files'),
			'No Local Changes': l10n.t('No Local Changes'),
			'Your Working Tree Is Clean': l10n.t('Your Working Tree Is Clean'),
			'Select a File to Review Its Changes': l10n.t('Select a File to Review Its Changes'),
			'Open Git Desktop': l10n.t('Open Git Desktop'),
			'Refresh': l10n.t('Refresh'),
			'Open in Editor': l10n.t('Open in Editor'),
			'View on GitHub': l10n.t('View on GitHub'),
			'Pull Requests': l10n.t('Pull Requests'),
			'Create Pull Request': l10n.t('Create Pull Request'),
			'Add Repository': l10n.t('Add Repository'),
			'Clone Repository': l10n.t('Clone Repository'),
			'No Git Repository': l10n.t('No Git Repository'),
			'Open or Clone a Repository to Get Started': l10n.t('Open or Clone a Repository to Get Started'),
			'Stash Changes': l10n.t('Stash Changes'),
			'Restore Stash': l10n.t('Restore Stash'),
			'Conflicts': l10n.t('Conflicts'),
			'Resolve Conflicts Before Committing': l10n.t('Resolve Conflicts Before Committing'),
			'Commit Details': l10n.t('Commit Details'),
			'Load More': l10n.t('Load More'),
			'No Commits Yet': l10n.t('No Commits Yet'),
			'Back': l10n.t('Back'),
			'Files': l10n.t('Files'),
			'Working Tree': l10n.t('Working Tree'),
			'Staged': l10n.t('Staged'),
			'Binary File or No Text Changes': l10n.t('Binary File or No Text Changes'),
			'Select All': l10n.t('Select All'),
			'Close': l10n.t('Close'),
			'Working': l10n.t('Working'),
			'Repository': l10n.t('Repository'),
			'Branch': l10n.t('Branch'),
			'Ahead': l10n.t('Ahead'),
			'Behind': l10n.t('Behind'),
			'Unstage File': l10n.t('Unstage File'),
			'Mark Resolved': l10n.t('Mark Resolved'),
			'Add Remote': l10n.t('Add Remote'),
			'Undo Last Commit': l10n.t('Undo Last Commit'),
			'Initialize Repository': l10n.t('Initialize Repository'),
		}).replace(/</g, '\\u003c');
		webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"></head><body class="${compact ? 'compact' : ''}"><div id="app"></div><script nonce="${nonce}">window.desktopLabels=${labels};</script><script nonce="${nonce}" src="${js}"></script></body></html>`;
		this.surfaces.add(webview);
		const listeners = [
			webview.onDidReceiveMessage((message: DesktopMessage) => { void this.receive(webview, message); }),
			new Disposable(() => this.surfaces.delete(webview))
		];
		const disposal = Disposable.from(...listeners);
		this.surfaceDisposables.add(disposal);
		return [new Disposable(() => { disposal.dispose(); this.surfaceDisposables.delete(disposal); })];
	}

	private repository(key?: string): Repository | undefined {
		return this.api.repositories.find(repository => repository.rootUri.toString() === (key ?? this.selected)) ?? this.api.repositories[0];
	}

	private changes(repository: Repository): Change[] {
		return desktopChanges(repository);
	}

	private async refresh(): Promise<void> {
		const revision = ++this.revision;
		const repository = this.repository();
		this.selected = repository?.rootUri.toString();
		try {
			const branches = repository ? await repository.getBranches({ remote: true, sort: 'committerdate' }) : [];
			if (revision !== this.revision) { return; }
			const state = repository?.state;
			const message = {
				type: 'state', busy: this.busy, selected: this.selected,
				repositories: this.api.repositories.map(repo => ({ id: repo.rootUri.toString(), name: path.basename(repo.rootUri.fsPath), path: repo.rootUri.fsPath })),
				branch: state?.HEAD?.name ?? state?.HEAD?.commit?.slice(0, 7),
				ahead: state?.HEAD?.ahead ?? 0, behind: state?.HEAD?.behind ?? 0,
				upstream: state?.HEAD?.upstream, remotes: state?.remotes.map(remote => remote.name) ?? [],
				fetched: this.selected ? this.fetched.get(this.selected) : undefined,
				conflicts: state?.mergeChanges.length ?? 0,
				branches: branches.filter(ref => ref.name && !ref.name.endsWith('/HEAD')).map(ref => ({ name: ref.name, remote: ref.type === RefType.RemoteHead })),
				changes: repository ? this.changes(repository).map(change => ({
					path: path.relative(repository.rootUri.fsPath, change.uri.fsPath).split(path.sep).join('/'),
					id: change.uri.toString(), status: change.status,
					staged: state?.indexChanges.some(staged => staged.uri.toString() === change.uri.toString()),
					conflict: state?.mergeChanges.some(conflict => conflict.uri.toString() === change.uri.toString())
				})) : []
			};
			for (const surface of this.surfaces) { void surface.postMessage(message); }
		} catch (error) { this.report(error); }
	}

	private report(error: Error): void {
		for (const surface of this.surfaces) { void surface.postMessage({ type: 'error', message: error.message }); }
	}

	private async receive(webview: Webview, message: DesktopMessage): Promise<void> {
		try {
			if (message.command === 'ready') { await this.refresh(); return; }
			if (message.command === 'open') { await this.open(); return; }
			if (message.command === 'selectRepository') {
				if (!this.api.repositories.some(repo => repo.rootUri.toString() === message.repository)) { return; }
				this.selected = message.repository;
				await this.refresh(); return;
			}
			if (message.command === 'clone') { await commands.executeCommand('git.clone'); return; }
			if (message.command === 'init') { await commands.executeCommand('git.init'); return; }
			if (message.command === 'addRepository') {
				const folders = await window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: l10n.t('Add Repository') });
				if (folders?.[0]) {
					const repository = await this.api.openRepository(folders[0]);
					if (!repository) { throw new Error(l10n.t('The selected folder is not a Git repository.')); }
					this.selected = repository.rootUri.toString(); await this.refresh();
				}
				return;
			}
			// Never let an old webview request mutate a newly selected repository.
			const repository = this.api.repositories.find(repo => repo.rootUri.toString() === message.repository);
			if (!repository) { throw new Error(l10n.t('The repository has been closed.')); }
			if (message.command === 'history') {
				const commits = repository.state.HEAD ? await repository.log({ maxEntries: 100, skip: Number(message.request) || 0 }) : [];
				void webview.postMessage({ type: 'history', repository: message.repository, skip: message.request ?? 0, commits }); return;
			}
			if (message.command === 'commitDetails') {
				if (!message.ref || !/^[a-f\d]{40,64}$/i.test(message.ref)) { return; }
				const changes = await repository.diffCommitWithStats(message.ref);
				void webview.postMessage({ type: 'commitDetails', repository: message.repository, ref: message.ref, files: changes.map(change => ({ path: path.relative(repository.rootUri.fsPath, change.uri.fsPath), id: change.uri.toString(), insertions: change.insertions, deletions: change.deletions })) }); return;
			}
			if (message.command === 'diff' || message.command === 'openFile') {
				const change = this.changes(repository).find(change => change.uri.toString() === message.path);
				if (!change) { throw new Error(l10n.t('This file is no longer changed. Refresh and select it again.')); }
				if (message.command === 'openFile') { await window.showTextDocument(change.uri); return; }
				let diff: string;
				if (change.status === Status.UNTRACKED || !repository.state.HEAD) {
					const data = await workspace.fs.readFile(change.uri);
					if (data.length > 1024 * 1024) { diff = l10n.t('File is too large to preview. Open it in the editor.'); }
					else if (data.includes(0)) { diff = l10n.t('Binary File or No Text Changes'); }
					else { diff = new TextDecoder().decode(data).split('\n').map(line => '+' + line).join('\n'); }
				} else { diff = await repository.diffWithHEAD(change.uri.fsPath); }
				void webview.postMessage({ type: 'diff', repository: message.repository, id: message.path, request: message.request, text: diff.slice(0, 1024 * 1024) }); return;
			}
			if (message.command === 'historyDiff') {
				if (!message.ref || !/^[a-f\d]{40,64}$/i.test(message.ref)) { return; }
				const changes = await repository.diffCommitWithStats(message.ref);
				const change = changes.find(change => change.uri.toString() === message.path);
				if (!change) { return; }
				const commit = await repository.getCommit(message.ref);
				const diff = commit.parents.length ? await repository.diffBetweenPatch(commit.parents[0], message.ref, change.uri.fsPath) : (await repository.show(message.ref, change.uri.fsPath)).split('\n').map(line => '+' + line).join('\n');
				void webview.postMessage({ type: 'diff', repository: message.repository, id: message.path, request: message.request, text: diff.slice(0, 1024 * 1024) }); return;
			}
			if (message.command === 'github' || message.command === 'pullRequests' || message.command === 'createPullRequest') {
				const remote = repository.state.remotes.find(remote => remote.name === repository.state.HEAD?.upstream?.remote) ?? repository.state.remotes[0];
				const match = remote?.fetchUrl?.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/);
				if (!match) { throw new Error(l10n.t('This repository does not have a GitHub remote.')); }
				let suffix = '';
				if (message.command === 'pullRequests') { suffix = '/pulls'; }
				if (message.command === 'createPullRequest') {
					if (!repository.state.HEAD?.upstream) { throw new Error(l10n.t('Publish the branch before creating a pull request.')); }
					suffix = `/compare/${encodeURIComponent(repository.state.HEAD.name ?? '')}?expand=1`;
				}
				await env.openExternal(Uri.parse(`https://github.com/${match[1]}${suffix}`)); return;
			}
			if (this.busy) { return; }
			this.busy = true;
			await this.refresh();
			try {
				switch (message.command) {
					case 'refresh': await repository.status(); break;
					case 'fetch':
						await repository.fetch({ remote: repository.state.HEAD?.upstream?.remote ?? repository.state.remotes.find(remote => remote.name === 'origin')?.name ?? repository.state.remotes[0]?.name, prune: true });
						this.fetched.set(repository.rootUri.toString(), new Date().toISOString()); break;
					case 'pull': await repository.pull(); break;
					case 'push':
						if (repository.state.HEAD?.upstream) { await repository.push(); }
						else {
							const remote = await window.showQuickPick(repository.state.remotes.map(remote => remote.name), { title: l10n.t('Publish Branch') });
							if (remote && repository.state.HEAD?.name) { await repository.push(remote, repository.state.HEAD.name, true); }
						} break;
					case 'checkout':
						if (message.ref) { await checkoutDesktopBranch(repository, message.ref); } break;
					case 'addRemote': {
						const name = await window.showInputBox({ title: l10n.t('Add Remote'), prompt: l10n.t('Remote name'), value: 'origin', ignoreFocusOut: true });
						if (!name?.trim()) { break; }
						const url = await window.showInputBox({ title: l10n.t('Add Remote'), prompt: l10n.t('Repository URL'), ignoreFocusOut: true });
						if (url?.trim()) { await repository.addRemote(name.trim(), url.trim()); } break;
					}
					case 'stage':
					case 'unstage': {
						const change = this.changes(repository).find(change => change.uri.toString() === message.path);
						if (change) {
							if (message.command === 'stage') { await repository.add([change.uri.fsPath]); }
							else { await repository.revert([change.uri.fsPath]); }
						} break;
					}
					case 'undo':
						if (!repository.state.HEAD?.commit || repository.state.HEAD.upstream && !repository.state.HEAD.ahead) { throw new Error(l10n.t('Only unpublished commits can be undone here.')); }
						await commands.executeCommand('git.undoCommit', repository.rootUri); break;
					case 'newBranch': {
						const name = await window.showInputBox({ title: l10n.t('New Branch'), prompt: l10n.t('Create a branch from the current branch and switch to it.'), ignoreFocusOut: true });
						if (name?.trim()) { await repository.createBranch(name.trim(), true); } break;
					}
					case 'merge': {
						const refs = await repository.getBranches({ remote: false });
						const ref = await window.showQuickPick(refs.filter(ref => ref.name !== repository.state.HEAD?.name).map(ref => ref.name ?? '').filter(Boolean), { title: l10n.t('Merge Into Current Branch') });
						if (ref) { await repository.merge(ref); } break;
					}
					case 'stash': await repository.createStash({ includeUntracked: true }); break;
					case 'restoreStash': await repository.popStash(); break;
					case 'commit': {
						await workspace.saveAll();
						await commitDesktopChanges(repository, message.paths ?? [], message.summary ?? '', message.description ?? '');
						void webview.postMessage({ type: 'committed', repository: message.repository }); break;
					}
				}
			} finally { this.busy = false; await this.refresh(); }
		} catch (error) { this.report(error); }
	}

	dispose(): void {
		this.panel?.dispose();
		Disposable.from(...this.disposables, ...this.repositoryListeners.values(), ...this.surfaceDisposables).dispose();
		this.surfaces.clear();
	}
}
