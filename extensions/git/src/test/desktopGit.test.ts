/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { commands, extensions, LogOutputChannel, Uri, window } from 'vscode';
import type { API, GitExtension, Repository } from '../api/git';
import { findGit, Git } from '../git';
import { checkoutDesktopBranch, commitDesktopChanges } from '../desktopOperations';

suite('git desktop', () => {
	let git: Git;
	let api: API;
	let logger: LogOutputChannel;
	let root: string;
	let repository: Repository;
	const originalGitConfigCount = process.env.GIT_CONFIG_COUNT;

	suiteSetup(async () => {
		process.env.GIT_CONFIG_COUNT = '0';
		logger = window.createOutputChannel('Git Desktop tests', { log: true });
		const found = await findGit(['git'], () => true, logger);
		git = new Git({ gitPath: found.path, version: found.version, userAgent: 'desktop-tests' });
		const extension = extensions.getExtension<GitExtension>('vscode.git');
		assert.ok(extension);
		await extension.activate();
		api = extension.exports.getAPI(1);
	});

	setup(async () => {
		root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vscode-desktop-tests-'));
		await git.init(root, { defaultBranch: 'main' });
		await git.exec(root, ['config', 'user.name', 'Desktop Test']);
		await git.exec(root, ['config', 'user.email', 'desktop-test@example.com']);
		await git.exec(root, ['config', 'commit.gpgsign', 'false']);
		await git.exec(root, ['config', 'core.autocrlf', 'false']);
		const opened = await api.openRepository(Uri.file(root));
		assert.ok(opened);
		repository = opened;
	});

	teardown(async () => {
		await commands.executeCommand('git.close', repository.rootUri);
		await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	suiteTeardown(() => {
		if (originalGitConfigCount === undefined) { delete process.env.GIT_CONFIG_COUNT; }
		else { process.env.GIT_CONFIG_COUNT = originalGitConfigCount; }
		logger.dispose();
	});

	test('selected-file commit leaves excluded untracked work untouched and preserves description', async () => {
		await fs.promises.writeFile(path.join(root, 'included.txt'), 'included\n');
		await fs.promises.writeFile(path.join(root, 'excluded.txt'), 'excluded\n');
		await commitDesktopChanges(repository, [Uri.file(path.join(root, 'included.txt')).toString()], 'Desktop commit', 'Detailed explanation');
		const commit = await repository.getCommit('HEAD');
		assert.deepStrictEqual({ message: commit.message.trim(), files: (await repository.diffCommitWithStats(commit.hash)).map(change => path.basename(change.uri.fsPath)), excluded: await fs.promises.readFile(path.join(root, 'excluded.txt'), 'utf8') }, { message: 'Desktop commit\n\nDetailed explanation', files: ['included.txt'], excluded: 'excluded\n' });
	});

	test('refuses excluded staged files without changing the index', async () => {
		await fs.promises.writeFile(path.join(root, 'selected.txt'), 'selected\n');
		await fs.promises.writeFile(path.join(root, 'already-staged.txt'), 'staged\n');
		await repository.add([path.join(root, 'already-staged.txt')]);
		const before = (await git.exec(root, ['ls-files', '--stage'])).stdout;
		await assert.rejects(commitDesktopChanges(repository, [Uri.file(path.join(root, 'selected.txt')).toString()], 'Selected', ''), /already staged/);
		assert.strictEqual((await git.exec(root, ['ls-files', '--stage'])).stdout, before);
	});

	test('history reports the commit delta rather than later working-tree changes', async () => {
		await fs.promises.writeFile(path.join(root, 'first.txt'), 'first\n');
		await commitDesktopChanges(repository, [Uri.file(path.join(root, 'first.txt')).toString()], 'Root', '');
		const first = (await repository.getCommit('HEAD')).hash;
		await fs.promises.writeFile(path.join(root, 'second.txt'), 'second\n');
		await commitDesktopChanges(repository, [Uri.file(path.join(root, 'second.txt')).toString()], 'Second', '');
		const second = (await repository.getCommit('HEAD')).hash;
		await fs.promises.writeFile(path.join(root, 'first.txt'), 'unrelated local change\n');
		assert.deepStrictEqual([(await repository.diffCommitWithStats(first)).map(change => path.basename(change.uri.fsPath)), (await repository.diffCommitWithStats(second)).map(change => path.basename(change.uri.fsPath))], [['first.txt'], ['second.txt']]);
	});

	test('selected deletions commit correctly and blank summaries are rejected', async () => {
		const uri = Uri.file(path.join(root, 'delete.txt'));
		await fs.promises.writeFile(uri.fsPath, 'delete\n');
		await commitDesktopChanges(repository, [uri.toString()], 'Add', '');
		await fs.promises.unlink(uri.fsPath);
		await assert.rejects(commitDesktopChanges(repository, [uri.toString()], '  ', ''), /summary/);
		await commitDesktopChanges(repository, [uri.toString()], 'Delete', '');
		assert.strictEqual((await git.exec(root, ['ls-tree', '--name-only', 'HEAD'])).stdout, '');
	});
	test('remote branch checkout creates a local tracking branch and leaves HEAD attached', async () => {
		await fs.promises.writeFile(path.join(root, 'base.txt'), 'base\n');
		await commitDesktopChanges(repository, [Uri.file(path.join(root, 'base.txt')).toString()], 'Base', '');
		await git.exec(root, ['remote', 'add', 'origin', root]);
		await git.exec(root, ['update-ref', 'refs/remotes/origin/feature', 'HEAD']);
		await repository.status();
		await checkoutDesktopBranch(repository, 'origin/feature');
		assert.deepStrictEqual({ branch: (await git.exec(root, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim(), upstream: (await git.exec(root, ['rev-parse', '--abbrev-ref', '@{upstream}'])).stdout.trim() }, { branch: 'feature', upstream: 'origin/feature' });
	});

});
