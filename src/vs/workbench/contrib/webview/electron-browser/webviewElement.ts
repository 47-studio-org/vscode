/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FindInPageOptions, OnBeforeRequestDetails, OnHeadersReceivedDetails, Response, WebContents, WebviewTag } from 'electron';
import { addDisposableListener } from 'vs/base/browser/dom';
import { Emitter, Event } from 'vs/base/common/event';
import { once } from 'vs/base/common/functional';
import { Disposable, toDisposable, IDisposable } from 'vs/base/common/lifecycle';
import { isMacintosh } from 'vs/base/common/platform';
import { URI } from 'vs/base/common/uri';
import * as modes from 'vs/editor/common/modes';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { ExtensionIdentifier } from 'vs/platform/extensions/common/extensions';
import { IFileService } from 'vs/platform/files/common/files';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ITunnelService } from 'vs/platform/remote/common/tunnel';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { Webview, WebviewContentOptions, WebviewExtensionDescription, WebviewOptions } from 'vs/workbench/contrib/webview/browser/webview';
import { WebviewPortMappingManager } from 'vs/workbench/contrib/webview/common/portMapping';
import { WebviewResourceScheme } from 'vs/workbench/contrib/webview/common/resourceLoader';
import { WebviewThemeDataProvider } from 'vs/workbench/contrib/webview/common/themeing';
import { registerFileProtocol } from 'vs/workbench/contrib/webview/electron-browser/webviewProtocols';
import { WebviewFindDelegate, WebviewFindWidget } from '../browser/webviewFindWidget';
import { areWebviewInputOptionsEqual } from '../browser/webviewWorkbenchService';
import { BaseWebview, WebviewMessageChannels } from 'vs/workbench/contrib/webview/browser/baseWebviewElement';

interface IKeydownEvent {
	key: string;
	keyCode: number;
	code: string;
	shiftKey: boolean;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	repeat: boolean;
}

class WebviewTagHandle extends Disposable {

	private _webContents: undefined | WebContents | 'destroyed';

	public constructor(
		public readonly webview: WebviewTag,
	) {
		super();

		this._register(addDisposableListener(this.webview, 'destroyed', () => {
			this._webContents = 'destroyed';
		}));

		this._register(addDisposableListener(this.webview, 'did-start-loading', once(() => {
			const contents = this.webContents;
			if (contents) {
				this._onFirstLoad.fire(contents);
				this._register(toDisposable(() => {
					contents.removeAllListeners();
				}));
			}
		})));
	}

	private readonly _onFirstLoad = this._register(new Emitter<WebContents>());
	public readonly onFirstLoad = this._onFirstLoad.event;

	public get webContents(): WebContents | undefined {
		if (this._webContents === 'destroyed') {
			return undefined;
		}
		if (this._webContents) {
			return this._webContents;
		}
		this._webContents = this.webview.getWebContents();
		return this._webContents;
	}
}

type OnBeforeRequestDelegate = (details: OnBeforeRequestDetails) => Promise<Response | undefined>;
type OnHeadersReceivedDelegate = (details: OnHeadersReceivedDetails) => { cancel: boolean; } | undefined;

class WebviewSession extends Disposable {

	private readonly _onBeforeRequestDelegates: Array<OnBeforeRequestDelegate> = [];
	private readonly _onHeadersReceivedDelegates: Array<OnHeadersReceivedDelegate> = [];

	public constructor(
		webviewHandle: WebviewTagHandle,
	) {
		super();

		this._register(webviewHandle.onFirstLoad(contents => {
			contents.session.webRequest.onBeforeRequest(async (details, callback) => {
				for (const delegate of this._onBeforeRequestDelegates) {
					const result = await delegate(details);
					if (typeof result !== 'undefined') {
						callback(result);
						return;
					}
				}
				callback({});
			});

			contents.session.webRequest.onHeadersReceived((details, callback) => {
				for (const delegate of this._onHeadersReceivedDelegates) {
					const result = delegate(details);
					if (typeof result !== 'undefined') {
						callback(result);
						return;
					}
				}
				callback({ cancel: false, responseHeaders: details.responseHeaders });
			});
		}));
	}

	public onBeforeRequest(delegate: OnBeforeRequestDelegate) {
		this._onBeforeRequestDelegates.push(delegate);
	}

	public onHeadersReceived(delegate: OnHeadersReceivedDelegate) {
		this._onHeadersReceivedDelegates.push(delegate);
	}
}

class WebviewProtocolProvider extends Disposable {
	constructor(
		handle: WebviewTagHandle,
		private readonly _getExtensionLocation: () => URI | undefined,
		private readonly _getLocalResourceRoots: () => ReadonlyArray<URI>,
		private readonly _fileService: IFileService,
	) {
		super();

		this._register(handle.onFirstLoad(contents => {
			this.registerProtocols(contents);
		}));
	}

	private registerProtocols(contents: WebContents) {
		registerFileProtocol(contents, WebviewResourceScheme, this._fileService, this._getExtensionLocation(), () =>
			this._getLocalResourceRoots()
		);
	}
}

class WebviewPortMappingProvider extends Disposable {

	constructor(
		session: WebviewSession,
		getExtensionLocation: () => URI | undefined,
		mappings: () => ReadonlyArray<modes.IWebviewPortMapping>,
		tunnelService: ITunnelService,
	) {
		super();
		const manager = this._register(new WebviewPortMappingManager(getExtensionLocation, mappings, tunnelService));

		session.onBeforeRequest(async details => {
			const redirect = await manager.getRedirect(details.url);
			return redirect ? { redirectURL: redirect } : undefined;
		});
	}
}

class WebviewKeyboardHandler extends Disposable {

	private _ignoreMenuShortcut = false;

	constructor(
		private readonly _webviewHandle: WebviewTagHandle
	) {
		super();

		if (this.shouldToggleMenuShortcutsEnablement) {
			this._register(_webviewHandle.onFirstLoad(contents => {
				contents.on('before-input-event', (_event, input) => {
					if (input.type === 'keyDown' && document.activeElement === this._webviewHandle.webview) {
						this._ignoreMenuShortcut = input.control || input.meta;
						this.setIgnoreMenuShortcuts(this._ignoreMenuShortcut);
					}
				});
			}));
		}

		this._register(addDisposableListener(this._webviewHandle.webview, 'ipc-message', (event) => {
			switch (event.channel) {
				case 'did-keydown':
					// Electron: workaround for https://github.com/electron/electron/issues/14258
					// We have to detect keyboard events in the <webview> and dispatch them to our
					// keybinding service because these events do not bubble to the parent window anymore.
					this.handleKeydown(event.args[0]);
					return;

				case 'did-focus':
					this.setIgnoreMenuShortcuts(this._ignoreMenuShortcut);
					break;

				case 'did-blur':
					this.setIgnoreMenuShortcuts(false);
					return;
			}
		}));
	}

	private get shouldToggleMenuShortcutsEnablement() {
		return isMacintosh;
	}

	private setIgnoreMenuShortcuts(value: boolean) {
		if (!this.shouldToggleMenuShortcutsEnablement) {
			return;
		}
		const contents = this._webviewHandle.webContents;
		if (contents) {
			contents.setIgnoreMenuShortcuts(value);
		}
	}

	private handleKeydown(event: IKeydownEvent): void {
		// Create a fake KeyboardEvent from the data provided
		const emulatedKeyboardEvent = new KeyboardEvent('keydown', event);
		// Force override the target
		Object.defineProperty(emulatedKeyboardEvent, 'target', {
			get: () => this._webviewHandle.webview
		});
		// And re-dispatch
		window.dispatchEvent(emulatedKeyboardEvent);
	}
}

interface WebviewContent {
	readonly html: string;
	readonly options: WebviewContentOptions;
	readonly state: string | undefined;
}

export class ElectronWebviewBasedWebview extends BaseWebview<WebviewTag> implements Webview, WebviewFindDelegate {
	private _webviewFindWidget: WebviewFindWidget | undefined;
	private _findStarted: boolean = false;
	private content: WebviewContent;

	private _focused = false;

	private readonly _onDidFocus = this._register(new Emitter<void>());
	public readonly onDidFocus: Event<void> = this._onDidFocus.event;

	public extension: WebviewExtensionDescription | undefined;

	constructor(
		options: WebviewOptions,
		contentOptions: WebviewContentOptions,
		private readonly webviewThemeDataProvider: WebviewThemeDataProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IFileService fileService: IFileService,
		@ITunnelService tunnelService: ITunnelService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IEnvironmentService private readonly _environementService: IEnvironmentService,
	) {
		super(options);

		this.content = {
			html: '',
			options: contentOptions,
			state: undefined
		};

		const webviewAndContents = this._register(new WebviewTagHandle(this.element!));
		const session = this._register(new WebviewSession(webviewAndContents));

		this._register(new WebviewProtocolProvider(
			webviewAndContents,
			() => this.extension ? this.extension.location : undefined,
			() => (this.content.options.localResourceRoots || []),
			fileService));

		this._register(new WebviewPortMappingProvider(
			session,
			() => this.extension ? this.extension.location : undefined,
			() => (this.content.options.portMapping || []),
			tunnelService,
		));

		this._register(new WebviewKeyboardHandler(webviewAndContents));

		this._register(addDisposableListener(this.element!, 'console-message', function (e: { level: number; message: string; line: number; sourceId: string; }) {
			console.log(`[Embedded Page] ${e.message}`);
		}));
		this._register(addDisposableListener(this.element!, 'dom-ready', () => {
			// Workaround for https://github.com/electron/electron/issues/14474
			if (this.element && (this._focused || document.activeElement === this.element)) {
				this.element.blur();
				this.element.focus();
			}
		}));
		this._register(addDisposableListener(this.element!, 'crashed', () => {
			console.error('embedded page crashed');
		}));

		this._register(this.on(WebviewMessageChannels.onmessage, (data: any) => {
			this._onMessage.fire(data);
		}));

		this._register(this.on(WebviewMessageChannels.didClickLink, (uri: string) => {
			this._onDidClickLink.fire(URI.parse(uri));
		}));

		this._register(this.on('synthetic-mouse-event', (rawEvent: any) => {
			if (!this.element) {
				return;
			}
			const bounds = this.element.getBoundingClientRect();
			try {
				window.dispatchEvent(new MouseEvent(rawEvent.type, {
					...rawEvent,
					clientX: rawEvent.clientX + bounds.left,
					clientY: rawEvent.clientY + bounds.top,
				}));
				return;
			} catch {
				// CustomEvent was treated as MouseEvent so don't do anything - https://github.com/microsoft/vscode/issues/78915
				return;
			}
		}));

		this._register(this.on('did-set-content', () => {
			if (this.element) {
				this.element.style.flex = '';
				this.element.style.width = '100%';
				this.element.style.height = '100%';
			}
		}));

		this._register(this.on(WebviewMessageChannels.didScroll, (scrollYPercentage: number) => {
			this._onDidScroll.fire({ scrollYPercentage: scrollYPercentage });
		}));

		this._register(this.on(WebviewMessageChannels.doReload, () => {
			this.reload();
		}));

		this._register(this.on(WebviewMessageChannels.doUpdateState, (state: any) => {
			this.state = state;
			this._onDidUpdateState.fire(state);
		}));

		this._register(this.on(WebviewMessageChannels.didFocus, () => {
			this.handleFocusChange(true);
		}));

		this._register(this.on(WebviewMessageChannels.didBlur, () => {
			this.handleFocusChange(false);
		}));

		this._register(this.on('no-csp-found', () => {
			this.handleNoCspFound();
		}));

		this._register(addDisposableListener(this.element!, 'devtools-opened', () => {
			this._send('devtools-opened');
		}));

		if (options.enableFindWidget) {
			this._webviewFindWidget = this._register(instantiationService.createInstance(WebviewFindWidget, this));

			this._register(addDisposableListener(this.element!, 'found-in-page', e => {
				this._hasFindResult.fire(e.result.matches > 0);
			}));
		}

		this.style();
		this._register(webviewThemeDataProvider.onThemeDataChanged(this.style, this));
	}

	protected createElement(options: WebviewOptions) {
		const element = document.createElement('webview');
		element.setAttribute('partition', `webview${Date.now()}`);
		element.setAttribute('webpreferences', 'contextIsolation=yes');
		element.className = `webview ${options.customClasses}`;

		element.style.flex = '0 1';
		element.style.width = '0';
		element.style.height = '0';
		element.style.outline = '0';

		element.preload = require.toUrl('./pre/electron-index.js');
		element.src = 'data:text/html;charset=utf-8,%3C%21DOCTYPE%20html%3E%0D%0A%3Chtml%20lang%3D%22en%22%20style%3D%22width%3A%20100%25%3B%20height%3A%20100%25%22%3E%0D%0A%3Chead%3E%0D%0A%09%3Ctitle%3EVirtual%20Document%3C%2Ftitle%3E%0D%0A%3C%2Fhead%3E%0D%0A%3Cbody%20style%3D%22margin%3A%200%3B%20overflow%3A%20hidden%3B%20width%3A%20100%25%3B%20height%3A%20100%25%22%3E%0D%0A%3C%2Fbody%3E%0D%0A%3C%2Fhtml%3E';

		return element;
	}

	public mountTo(parent: HTMLElement) {
		if (!this.element) {
			return;
		}

		if (this._webviewFindWidget) {
			parent.appendChild(this._webviewFindWidget.getDomNode()!);
		}
		parent.appendChild(this.element);
	}

	private readonly _onDidClickLink = this._register(new Emitter<URI>());
	public readonly onDidClickLink = this._onDidClickLink.event;

	private readonly _onDidScroll = this._register(new Emitter<{ scrollYPercentage: number; }>());
	public readonly onDidScroll = this._onDidScroll.event;

	private readonly _onDidUpdateState = this._register(new Emitter<string | undefined>());
	public readonly onDidUpdateState = this._onDidUpdateState.event;

	private readonly _onMessage = this._register(new Emitter<any>());
	public readonly onMessage = this._onMessage.event;

	private readonly _onMissingCsp = this._register(new Emitter<ExtensionIdentifier>());
	public readonly onMissingCsp = this._onMissingCsp.event;

	private _send(channel: string, data?: any): void {
		this._ready
			.then(() => {
				if (this.element) {
					this.element.send(channel, data);
				}
			})
			.catch(err => console.error(err));
	}

	public set initialScrollProgress(value: number) {
		this._send('initial-scroll-position', value);
	}

	public set state(state: string | undefined) {
		this.content = {
			html: this.content.html,
			options: this.content.options,
			state,
		};
	}

	public set contentOptions(options: WebviewContentOptions) {
		if (areWebviewInputOptionsEqual(options, this.content.options)) {
			return;
		}

		this.content = {
			html: this.content.html,
			options: options,
			state: this.content.state,
		};
		this.doUpdateContent();
	}

	public set html(value: string) {
		this.content = {
			html: value,
			options: this.content.options,
			state: this.content.state,
		};
		this.doUpdateContent();
	}

	private doUpdateContent() {
		this._send('content', {
			contents: this.content.html,
			options: this.content.options,
			state: this.content.state
		});
	}

	public focus(): void {
		if (!this.element) {
			return;
		}
		try {
			this.element.focus();
		} catch {
			// noop
		}
		this._send('focus');

		// Handle focus change programmatically (do not rely on event from <webview>)
		this.handleFocusChange(true);
	}

	private handleFocusChange(isFocused: boolean): void {
		this._focused = isFocused;
		if (isFocused) {
			this._onDidFocus.fire();
		}
	}

	private _hasAlertedAboutMissingCsp = false;

	private handleNoCspFound(): void {
		if (this._hasAlertedAboutMissingCsp) {
			return;
		}
		this._hasAlertedAboutMissingCsp = true;

		if (this.extension && this.extension.id) {
			if (this._environementService.isExtensionDevelopment) {
				this._onMissingCsp.fire(this.extension.id);
			}

			type TelemetryClassification = {
				extension?: { classification: 'SystemMetaData', purpose: 'FeatureInsight'; };
			};
			type TelemetryData = {
				extension?: string,
			};

			this._telemetryService.publicLog2<TelemetryData, TelemetryClassification>('webviewMissingCsp', {
				extension: this.extension.id.value
			});
		}
	}

	public sendMessage(data: any): void {
		this._send('message', data);
	}

	private style(): void {
		const { styles, activeTheme } = this.webviewThemeDataProvider.getWebviewThemeData();
		this._send('styles', { styles, activeTheme });

		if (this._webviewFindWidget) {
			this._webviewFindWidget.updateTheme(this.webviewThemeDataProvider.getTheme());
		}
	}

	private readonly _hasFindResult = this._register(new Emitter<boolean>());
	public readonly hasFindResult: Event<boolean> = this._hasFindResult.event;

	public startFind(value: string, options?: FindInPageOptions) {
		if (!value || !this.element) {
			return;
		}

		// ensure options is defined without modifying the original
		options = options || {};

		// FindNext must be false for a first request
		const findOptions: FindInPageOptions = {
			forward: options.forward,
			findNext: false,
			matchCase: options.matchCase,
			medialCapitalAsWordStart: options.medialCapitalAsWordStart
		};

		this._findStarted = true;
		this.element.findInPage(value, findOptions);
	}

	/**
	 * Webviews expose a stateful find API.
	 * Successive calls to find will move forward or backward through onFindResults
	 * depending on the supplied options.
	 *
	 * @param value The string to search for. Empty strings are ignored.
	 */
	public find(value: string, previous: boolean): void {
		if (!this.element) {
			return;
		}

		// Searching with an empty value will throw an exception
		if (!value) {
			return;
		}

		const options = { findNext: true, forward: !previous };
		if (!this._findStarted) {
			this.startFind(value, options);
			return;
		}

		this.element.findInPage(value, options);
	}

	public stopFind(keepSelection?: boolean): void {
		this._hasFindResult.fire(false);
		if (!this.element) {
			return;
		}
		this._findStarted = false;
		this.element.stopFindInPage(keepSelection ? 'keepSelection' : 'clearSelection');
	}

	public showFind() {
		if (this._webviewFindWidget) {
			this._webviewFindWidget.reveal();
		}
	}

	public hideFind() {
		if (this._webviewFindWidget) {
			this._webviewFindWidget.hide();
		}
	}

	public runFindAction(previous: boolean) {
		if (this._webviewFindWidget) {
			this._webviewFindWidget.find(previous);
		}
	}

	public reload() {
		this.doUpdateContent();
	}

	public selectAll() {
		if (this.element) {
			this.element.selectAll();
		}
	}

	public copy() {
		if (this.element) {
			this.element.copy();
		}
	}

	public paste() {
		if (this.element) {
			this.element.paste();
		}
	}

	public cut() {
		if (this.element) {
			this.element.cut();
		}
	}

	public undo() {
		if (this.element) {
			this.element.undo();
		}
	}

	public redo() {
		if (this.element) {
			this.element.redo();
		}
	}

	protected on<T = unknown>(channel: WebviewMessageChannels | string, handler: (data: T) => void): IDisposable {
		if (!this.element) {
			return Disposable.None;
		}
		return addDisposableListener(this.element, 'ipc-message', (event) => {
			if (!this.element) {
				return;
			}
			if (event.channel === channel && event.args && event.args.length) {
				handler(event.args[0]);
			}
		});
	}
}
