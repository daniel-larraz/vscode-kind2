/*
 * Copyright (c) 2021, Board of Trustees of the University of Iowa All rights reserved.
 *
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 */

import * as os from "os";
import * as path from "path";
import { CancellationToken, CancellationTokenSource, CodeLens, CodeLensProvider, DecorationOptions, Event, EventEmitter, ExtensionContext, MarkdownString, Position, ProviderResult, Range, ShellExecution, ShellQuotedString, ShellQuoting, Task, tasks, TaskScope, TextDocument, TextEditorDecorationType, ThemeColor, ThemeIcon, TreeDataProvider, TreeItem, TreeItemCollapsibleState, TreeView, Uri, window, workspace } from "vscode";
import { LanguageClient } from "vscode-languageclient";
import { Analysis, Component, File, Property, State, stateIcon, statePath, TreeNode } from "./treeNode";
import { WebPanel } from "./webviewPanel";

export class Kind2 implements TreeDataProvider<TreeNode>, CodeLensProvider {
  private _fileMap: Map<String, Set<String>>;
  private _files: File[];
  private _runningChecks: Map<Component, CancellationTokenSource>;
  private readonly _treeDataChanged: EventEmitter<TreeNode | null | undefined>;
  private readonly _codeLensesChanged: EventEmitter<void>;
  private readonly _decorationTypeMap: Map<State, TextEditorDecorationType>;

  constructor(private _context: ExtensionContext, private _client: LanguageClient) {
    this._fileMap = new Map<String, Set<String>>();
    this._files = [];
    this._runningChecks = new Map<Component, CancellationTokenSource>();
    this._treeDataChanged = new EventEmitter<TreeNode | undefined | null>();
    this._codeLensesChanged = new EventEmitter<void>();
    this.onDidChangeTreeData = this._treeDataChanged.event;
    this.onDidChangeCodeLenses = this._codeLensesChanged.event;
    this._decorationTypeMap = new Map<State, TextEditorDecorationType>([
      ["pending", window.createTextEditorDecorationType({ gutterIconPath: this._context.asAbsolutePath(statePath("pending")) })],
      ["running", window.createTextEditorDecorationType({ gutterIconPath: this._context.asAbsolutePath(statePath("running")) })],
      ["passed", window.createTextEditorDecorationType({ gutterIconPath: this._context.asAbsolutePath(statePath("passed")) })],
      ["failed", window.createTextEditorDecorationType({ gutterIconPath: this._context.asAbsolutePath(statePath("failed")) })],
      ["errored", window.createTextEditorDecorationType({ gutterIconPath: this._context.asAbsolutePath(statePath("errored")) })]]);
  }

  onDidChangeCodeLenses?: Event<void> | undefined;

  provideCodeLenses(document: TextDocument, _token: CancellationToken): ProviderResult<CodeLens[]> {
    let codeLenses: CodeLens[] = [];
    let file = this._files.find(file => file.uri === document.uri.toString());
    if (file) {
      for (const component of file.components) {
        let range = new Range(component.line, 0, component.line, 0);
        if (component.state === "running") {
          codeLenses.push(new CodeLens(range, { title: "Cancel", command: "kind2/cancel", arguments: [component] }));
        } else {
          codeLenses.push(new CodeLens(range, { title: "Check", command: "kind2/check", arguments: [component] }));
        }
        codeLenses.push(new CodeLens(range, { title: "Simulate", command: "kind2/interpret", arguments: [component, "[]"] }));
        codeLenses.push(new CodeLens(range, { title: "Raw Output", command: "kind2/raw", arguments: [component] }));
        codeLenses.push(new CodeLens(range, { title: "Show in Explorer", command: "kind2/reveal", arguments: [component] }));
      }
    }
    return codeLenses;
  }

  public readonly onDidChangeTreeData: Event<TreeNode | null | undefined>;

  public getTreeItem(element: TreeNode): TreeItem | Thenable<TreeItem> {
    let item: TreeItem;
    if (element instanceof File) {
      item = new TreeItem(element.uri, element.components.length === 0 ? TreeItemCollapsibleState.None : TreeItemCollapsibleState.Expanded);
    }
    else if (element instanceof Component) {
      item = new TreeItem(element.name, element.analyses.length === 0 ? TreeItemCollapsibleState.None : TreeItemCollapsibleState.Expanded);
      item.contextValue = element.state === "running" ? "running" : "component";
      item.iconPath = Uri.file(path.join(this._context.extensionPath, statePath(element.state)));
      // item.iconPath = stateIcon(element.state);
    }
    else if (element instanceof Analysis) {
      let label = "Abstract: " + (element.abstract.length == 0 ? "none" : "[" + element.abstract.toString() + "]");
      label += " | Concrete: " + (element.concrete.length == 0 ? "none" : "[" + element.concrete.toString() + "]");
      item = new TreeItem(label, element.properties.length === 0 ? TreeItemCollapsibleState.None : TreeItemCollapsibleState.Expanded);
      item.contextValue = "analysis";
    }
    else {
      item = new TreeItem(element.name, TreeItemCollapsibleState.None);
      if (element.state == "failed") {
        item.contextValue = "failed";
      }
      item.iconPath = Uri.file(path.join(this._context.extensionPath, statePath(element.state)));
      // item.iconPath = stateIcon(element.state);
    }
    return item;
  }

  public getChildren(element?: TreeNode): ProviderResult<TreeNode[]> {
    if (element == undefined) {
      return this._files;
    }
    if (element instanceof File) {
      return element.components;
    }
    if (element instanceof Component) {
      return element.analyses;
    }
    if (element instanceof Analysis) {
      return element.properties;
    }
  }

  public getParent(element: TreeNode): ProviderResult<TreeNode> {
    return element.parent;
  }

  public updateDecorations(): void {
    let decorations = new Map<string, Map<State, DecorationOptions[]>>();
    for (const file of this._files) {
      decorations.set(file.uri, new Map<State, DecorationOptions[]>([["pending", []], ["running", []], ["passed", []], ["failed", []], ["errored", []]]));
    }
    for (const file of this._files) {
      for (const component of file.components) {
        decorations.get(component.uri)?.get(component.state)?.push({ range: new Range(new Position(component.line, 0), (new Position(component.line, 0))) });
        for (const property of component.properties) {
          if (decorations.has(property.uri)) {
            let decorationOptions: DecorationOptions = { range: new Range(new Position(property.line, 0), (new Position(property.line, 100))) };
            decorations.get(property.uri)?.get(property.state)?.push(decorationOptions);
          }
        }
      }
    }
    for (const uri of decorations.keys()) {
      let editor = window.visibleTextEditors.find(editor => editor.document.uri.toString() === uri);
      for (const state of <State[]>["pending", "running", "passed", "failed", "errored"]) {
        editor?.setDecorations(this._decorationTypeMap.get(state)!, decorations.get(uri)?.get(state)!);
      }
    }
  }

  private getPlatform(): string {
    let platform: string;
    switch (os.platform()) {
      case "linux":
        return "linux";
      case "darwin":
        return "macos";
      default:
        throw `Kind 2 extension does not support ${platform} platform.`;
    }
  }

  public getDefaultKind2Path(): string {
    return this._context.asAbsolutePath(path.join(this.getPlatform(), "kind2"));
  }

  public getDefaultZ3Path(): string {
    return this._context.asAbsolutePath(path.join(this.getPlatform(), "z3"));
  }

  public async updateComponents(uri: string): Promise<void> {
    // First, cancel all running checks.
    for (const check of this._runningChecks.values()) {
      check.cancel();
    }
    this._runningChecks = new Map<Component, CancellationTokenSource>();
    // Then, remove all components of files depending on this one.
    // for (const file of this._files) {
    //   if (this._fileMap.has(file.uri) && this._fileMap.get(file.uri).has(uri)) {
    //     file.components = [];
    //   }
    // }
    // This is now a main file.
    this._fileMap.set(uri, new Set<String>());
    const components: any[] = await this._client.sendRequest("kind2/getComponents", uri).then(values => {
      return (values as string[]).map(value => JSON.parse(value));
    });
    // Remove this file, if we need to replace its components.
    let mainFile = this._files.find(f => f.uri === uri);
    let newFiles: File[] = [];
    if (components.length !== 0 && mainFile) {
      this._files = this._files.filter(f => f.uri !== uri);
      mainFile.components = []
      newFiles.push(mainFile);
    }
    for (let component of components) {
      component.file = (component.file as string).replace("%2520", "%20");
      this._fileMap.get(uri).add(component.file);
      // Only add components if this is the first time we see their files.
      if (this._files.find(f => f.uri === component.file) === undefined) {
        let file = newFiles.find(f => f.uri === component.file);
        if (!file) {
          file = new File(component.file);
          newFiles.push(file);
        }
        file.components.push(new Component(component.name, component.startLine - 1, file));
      }
    }
    this._files = this._files.concat(newFiles);
    // Finally, remove files that no main file depends on.
    let values = new Set<String>();
    for (const value of this._fileMap.values()) {
      for (const uri of value) {
        values.add(uri);
      }
    }
    let toRemove = new Set<File>();
    for (const file of this._files) {
      if (!values.has(file.uri)) {
        toRemove.add(file);
      }
    }
    this._files = this._files.filter(f => !toRemove.has(f));
    this._treeDataChanged.fire(undefined);
    this._codeLensesChanged.fire();
    this.updateDecorations();
  }

  public async showSource(node: TreeNode): Promise<void> {
    if (node instanceof Analysis) {
      return;
    }
    let range = new Range(node.line, 0, node.line, 0);
    await window.showTextDocument(Uri.parse(node.uri, true), { selection: range });
  }

  public async check(component: Component): Promise<void> {
    component.analyses = [];
    component.state = "running";
    let files: File[] = [];
    for (const uri of this._fileMap.get(component.uri)) {
      let file = this._files.find(f => f.uri === uri);
      files.push(file);
    }
    let modifiedComponents: Component[] = [];
    modifiedComponents.push(component);
    for (const component of modifiedComponents) {
      this._treeDataChanged.fire(component);
    }
    this._codeLensesChanged.fire();
    this.updateDecorations();
    let tokenSource = new CancellationTokenSource();
    this._runningChecks.set(component, tokenSource);
    await this._client.sendRequest("kind2/check", [component.uri, component.name], tokenSource.token).then((values: string[]) => {
      let results: any[] = values.map(s => JSON.parse(s));
      for (const nodeResult of results) {
        // TODO: fix file issue and add a link to kind2 website.
        let component = undefined;
        let i = 0;
        while (component === undefined) {
          component = files[i].components.find(c => c.name === nodeResult.name);
          ++i;
        }
        component.analyses = [];
        for (const analysisResult of nodeResult.analyses) {
          let analysis: Analysis = new Analysis(analysisResult.abstract, analysisResult.concrete, component);
          for (const propertyResult of analysisResult.properties) {
            let property = new Property(propertyResult.name, propertyResult.line - 1, propertyResult.file, analysis);
            property.state = propertyResult.answer.value === "valid" ? "passed" : "failed";
            analysis.properties.push(property);
          }
          component.analyses.push(analysis);
        }
        if (component.analyses.length == 0) {
          component.state = "passed";
        }
        modifiedComponents.push(component);
      }
      if (results.length == 0) {
        component.state = "passed";
      }
    }).catch(reason => {
      window.showErrorMessage(reason.message);
      component.state = "errored";
    });
    for (const component of modifiedComponents) {
      this._treeDataChanged.fire(component);
    }
    this._codeLensesChanged.fire();
    this.updateDecorations();
    this._runningChecks.delete(component);
  }

  public cancel(component: Component) {
    this._runningChecks.get(component).cancel();
  }

  public async interpret(uri: string, main: string, json: string): Promise<void> {
    await this._client.sendRequest("kind2/interpret", [uri, main, json]).then(async (interp: string) => {
      WebPanel.createOrShow(this._context.extensionPath);
      await WebPanel.currentPanel?.sendMessage({ uri: uri, main: main, json: interp });
    }).catch(reason => {
      window.showErrorMessage(reason.message);
    });
  }

  public async raw(component: Component): Promise<void> {
    await this._client.sendRequest("kind2/getKind2Cmd", [component.uri, component.name]).then(async (cmd: string[]) => {
      cmd = cmd.map(o => o.replace("%20", " "));
      await tasks.executeTask(new Task({ type: "kind2" }, TaskScope.Workspace, component.name, "Kind 2", new ShellExecution(cmd[0], cmd.slice(1))));
    }).catch(reason => {
      window.showErrorMessage(reason.message);
    });
  }

  public async reveal(node: TreeNode, treeView: TreeView<TreeNode>): Promise<void> {
    await treeView.reveal(node);
  }

  public async counterExample(property: Property): Promise<void> {
    await this._client.sendRequest("kind2/counterExample", [property.parent.parent.uri, property.parent.parent.name,
    property.parent.abstract, property.parent.concrete, property.name]).then((ce: string) => {
      WebPanel.createOrShow(this._context.extensionPath);
      WebPanel.currentPanel?.sendMessage({ uri: property.parent.parent.uri, main: property.parent.parent.name, json: ce });
    }).catch(reason => {
      window.showErrorMessage(reason.message);
    });
  }
}
