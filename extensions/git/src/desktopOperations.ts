/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { l10n } from 'vscode';
import type { Change, Repository } from './api/git';
import { RefType } from './api/git.constants';

/** Coalesces staged and unstaged changes, showing the current working-tree version. */
export function desktopChanges(repository: Repository): Change[] {
	const state = repository.state;
	return [...new Map([...state.indexChanges, ...state.workingTreeChanges, ...state.untrackedChanges, ...state.mergeChanges].map(change => [change.uri.toString(), change])).values()];
}

/** Commits only selected files, without silently including other staged work. */
export async function commitDesktopChanges(repository: Repository, paths: readonly string[], summary: string, description: string): Promise<void> {
	await repository.status();
	if (!summary.trim()) { throw new Error(l10n.t('A commit summary is required.')); }
	if (repository.state.mergeChanges.length) { throw new Error(l10n.t('Resolve Conflicts Before Committing')); }
	const selected = desktopChanges(repository).filter(change => paths.includes(change.uri.toString()));
	if (!selected.length) { throw new Error(l10n.t('Select at least one changed file to commit.')); }
	if (repository.state.indexChanges.some(change => !paths.includes(change.uri.toString()))) {
		throw new Error(l10n.t('Some excluded files are already staged. Include them or unstage them before committing.'));
	}
	await repository.add(selected.map(change => change.uri.fsPath));
	await repository.commit(summary.trim() + (description.trim() ? '\n\n' + description.trim() : ''));
}

/** Checks out remote branches as local tracking branches rather than detaching HEAD. */
export async function checkoutDesktopBranch(repository: Repository, name: string): Promise<void> {
	const refs = await repository.getBranches({ remote: true });
	const ref = refs.find(ref => ref.name === name);
	if (!ref) { throw new Error(l10n.t('The selected branch no longer exists.')); }
	if (ref.type === RefType.RemoteHead) {
		const localName = name.slice((ref.remote?.length ?? name.indexOf('/')) + 1);
		if (refs.some(ref => ref.type === RefType.Head && ref.name === localName)) {
			await repository.checkout(localName);
		} else {
			await repository.createBranch(localName, true, name);
			await repository.setBranchUpstream(localName, name);
		}
	} else { await repository.checkout(name); }
}
