// ==========================================================================
// A small stand-in for the 'vscode' module over real files, enough to drive the custom editor providers from a
// test (tests/provider_test.js): Uri, workspace.fs, text documents with edits and save, workspace edits,
// messages, commands, diagnostics and editor registration. Open documents are kept in memory as VS Code does;
// an edit makes a document dirty until it is saved.
// ==========================================================================
'use strict';
const fs = require('fs');
const path = require('path');

class Uri {
    constructor(fsPath) { this.fsPath = fsPath; this.path = fsPath; this.scheme = 'file'; }
    toString() { return 'file://' + this.fsPath; }
    static file(p) { return new Uri(path.resolve(p)); }
    static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
}

class FileSystemError extends Error {
    constructor(message, code) { super(message); this.code = code; }
}

const FileType = { File: 1, Directory: 2 };

class Range {
    constructor(startLine, startCharacter, endLine, endCharacter) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
    }
}

const listeners = { change: [], save: [] };
const event = (list) => (fn) => { list.push(fn); return { dispose() { list.splice(list.indexOf(fn), 1); } }; };

class TextDocument {
    constructor(uri, text) { this.uri = uri; this.text = text; this.isDirty = false; }
    getText() { return this.text; }
    get lineCount() { return this.text.split('\n').length; }
    positionAt(offset) {
        const before = this.text.slice(0, offset).split('\n');
        return { line: before.length - 1, character: before[before.length - 1].length };
    }
    lineAt(line) { return { range: new Range(line, 0, line, (this.text.split('\n')[line] || '').length) }; }
    async save() {
        fs.writeFileSync(this.uri.fsPath, this.text);
        this.isDirty = false;
        listeners.save.forEach(fn => fn(this));
        return true;
    }
}

class WorkspaceEdit {
    constructor() { this.map = new Map(); }
    replace(uri, range, text) {
        const key = uri.toString();
        if (!this.map.has(key)) this.map.set(key, [uri, []]);
        this.map.get(key)[1].push({ range, text });
    }
    get size() { return this.map.size; }
    entries() { return [...this.map.values()]; }
}

const documents = [];
const log = { info: [], error: [], commands: [], posted: [] };

function missing(uri) { return new FileSystemError(`${uri.fsPath} not found`, 'FileNotFound'); }

const workspace = {
    fs: {
        async readFile(uri) {
            if (!fs.existsSync(uri.fsPath)) throw missing(uri);
            return new Uint8Array(fs.readFileSync(uri.fsPath));
        },
        async writeFile(uri, data) {
            fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
            fs.writeFileSync(uri.fsPath, Buffer.from(data));
            // an open, unmodified document follows the file, as in VS Code
            const doc = documents.find(d => d.uri.fsPath === uri.fsPath);
            if (doc && !doc.isDirty) { doc.text = Buffer.from(data).toString('utf8'); listeners.change.forEach(fn => fn({ document: doc })); }
        },
        async stat(uri) {
            if (!fs.existsSync(uri.fsPath)) throw missing(uri);
            return { type: fs.statSync(uri.fsPath).isDirectory() ? FileType.Directory : FileType.File };
        },
        async readDirectory(uri) {
            return fs.readdirSync(uri.fsPath, { withFileTypes: true }).map(e => [e.name, e.isDirectory() ? FileType.Directory : FileType.File]);
        },
        async rename(from, to) { fs.renameSync(from.fsPath, to.fsPath); },
        async createDirectory(uri) { fs.mkdirSync(uri.fsPath, { recursive: true }); },
    },
    get textDocuments() { return documents; },
    async openTextDocument(uri) {
        let doc = documents.find(d => d.uri.fsPath === uri.fsPath);
        if (!doc) {
            if (!fs.existsSync(uri.fsPath)) throw missing(uri);
            doc = new TextDocument(uri, fs.readFileSync(uri.fsPath, 'utf8'));
            documents.push(doc);
        }
        return doc;
    },
    async applyEdit(edit) {
        for (const [uri, edits] of edit.entries()) {
            const doc = await workspace.openTextDocument(uri);
            for (const e of edits) {
                const lines = doc.text.split('\n');
                const offset = (p) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + Math.min(p.character, (lines[p.line] || '').length);
                const start = offset(e.range.start), end = e.range.end.line >= lines.length ? doc.text.length : offset(e.range.end);
                doc.text = doc.text.slice(0, start) + e.text + doc.text.slice(end);
            }
            doc.isDirty = true;
            listeners.change.forEach(fn => fn({ document: doc }));
        }
        return true;
    },
    onDidChangeTextDocument: event(listeners.change),
    onDidSaveTextDocument: event(listeners.save),
};

const providers = {};
const openTabs = [];   // uris shown as open tabs (window.tabGroups)
const window = {
    showInformationMessage(m) { log.info.push(m); return Promise.resolve(); },
    showErrorMessage(m) { log.error.push(m); return Promise.resolve(); },
    showWarningMessage(m) { log.info.push(m); return Promise.resolve(); },
    async showTextDocument(uri) { log.commands.push(['showTextDocument', uri.fsPath]); },
    registerCustomEditorProvider(viewType, provider) { providers[viewType] = provider; return { dispose() {} }; },
    tabGroups: { get all() { return [{ tabs: openTabs.map(uri => ({ input: { uri } })) }]; } },
};

const commands = {
    async executeCommand(id, ...args) {
        log.commands.push([id, ...args.map(a => (a instanceof Uri ? a.fsPath : a))]);
        if (id === 'vscode.executeDocumentRenameProvider') throw new Error('no rename provider');   // no clangd here
        return undefined;
    },
};

const languages = { createDiagnosticCollection() { return { set() {}, delete() {}, dispose() {} }; } };
class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } }
const DiagnosticSeverity = { Error: 0, Warning: 1 };

// A webview panel whose messages the test sends and whose posts it reads
function panel() {
    const p = {
        handler: null, disposed: [],
        webview: {
            options: {}, html: '',
            asWebviewUri: (u) => u,
            postMessage(m) { log.posted.push(m); return Promise.resolve(true); },
            onDidReceiveMessage(h) { p.handler = h; return { dispose() {} }; },
        },
        onDidDispose(fn) { p.disposed.push(fn); return { dispose() {} }; },
        send(message) { return p.handler(message); },
    };
    return p;
}

module.exports = {
    Uri, FileSystemError, FileType, Range, WorkspaceEdit, workspace, window, commands, languages, Diagnostic,
    DiagnosticSeverity, test: { log, providers, openTabs, panel, documents },
};
