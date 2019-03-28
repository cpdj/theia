/********************************************************************************
 * Copyright (C) 2017 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { inject, injectable, postConstruct } from 'inversify';
import {
    BaseLanguageClientContribution, LanguageClientFactory,
    LanguageClientOptions,
    ILanguageClient
} from '@theia/languages/lib/browser';
import { Languages, Workspace } from '@theia/languages/lib/browser';
import { ILogger } from '@theia/core/lib/common/logger';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { CPP_LANGUAGE_ID, CPP_LANGUAGE_NAME, HEADER_AND_SOURCE_FILE_EXTENSIONS, CppStartParameters } from '../common';
import { CppBuildConfigurationManager } from './cpp-build-configurations';
import { CppBuildConfigurationsStatusBarElement } from './cpp-build-configurations-statusbar-element';
import { CppBuildConfiguration } from '../common/cpp-build-configuration-protocol';
import { CppPreferences } from './cpp-preferences';
import URI from '@theia/core/lib/common/uri';

/**
 * Clangd extension to set clangd-specific "initializationOptions" in the
 * "initialize" request and for the "workspace/didChangeConfiguration"
 * notification since the data received is described as 'any' type in LSP.
 */
interface ClangdConfigurationParamsChange {
    compilationDatabasePath?: string;

    /**
     * Experimental field.
     */
    compilationDatabaseMap?: Array<{
        sourceDir: string;
        dbPath: string;
    }>;
}

@injectable()
export class CppLanguageClientContribution extends BaseLanguageClientContribution {

    readonly id = CPP_LANGUAGE_ID;
    readonly name = CPP_LANGUAGE_NAME;

    protected currentCompilationDatabaseMap = new Map<string, string>();

    @inject(CppPreferences)
    protected readonly cppPreferences: CppPreferences;

    @inject(CppBuildConfigurationManager)
    protected readonly cppBuildConfigurations: CppBuildConfigurationManager;

    @inject(CppBuildConfigurationsStatusBarElement)
    protected readonly cppBuildConfigurationsStatusBarElement: CppBuildConfigurationsStatusBarElement;

    @inject(WindowService)
    protected readonly windowService: WindowService;

    @inject(ILogger)
    protected readonly logger: ILogger;

    constructor(
        @inject(Workspace) protected readonly workspace: Workspace,
        @inject(Languages) protected readonly languages: Languages,
        @inject(LanguageClientFactory) protected readonly languageClientFactory: LanguageClientFactory,
    ) {
        super(workspace, languages, languageClientFactory);
    }

    @postConstruct()
    protected init() {
        this.cppBuildConfigurations.onActiveConfigChange2(configs => {
            const normalized = new Map<string, string>();
            for (const [root, config] of configs) {
                normalized.set(root, config.directory);
            }
            this.onActiveBuildConfigChanged(normalized);
        });
        this.cppPreferences.onPreferenceChanged(e => {
            if (this.running) {
                this.restart();
            }
        });
    }

    protected onReady(languageClient: ILanguageClient): void {
        super.onReady(languageClient);

        // Display the C/C++ build configurations status bar element to select active build config
        this.cppBuildConfigurationsStatusBarElement.show();
    }

    protected async updateCurrentCompilationDatabaseMap() {
        const activeConfigurations = new Map<string, CppBuildConfiguration>();
        const databaseMap = new Map<string, string>();

        for (const [source, config] of this.cppBuildConfigurations.getAllActiveConfigs!().entries()) {
            if (typeof config !== 'undefined') {
                activeConfigurations.set(source, config);
            }
        }

        if (activeConfigurations.size > 1 && !this.cppPreferences['cpp.experimentalCompilationDatabaseMap']) {
            databaseMap.clear(); // Use only one configuration.
            const configs = [...activeConfigurations.values()];
            try {
                const mergedDatabaseUri = new URI(await this.cppBuildConfigurations.getMergedCompilationDatabase!({
                    configurations: configs,
                }));
                databaseMap.set('undefined', mergedDatabaseUri.path.toString());
            } catch (error) {
                this.logger.error(error);
                databaseMap.set('undefined', configs[0].directory);
            }
        }

        this.currentCompilationDatabaseMap.clear();
        for (const [source, build] of databaseMap.entries()) {
            this.currentCompilationDatabaseMap.set(source, build);
        }
    }

    private createClangdConfigurationParams(configs: Map<string, string>): ClangdConfigurationParamsChange {
        const clangdParams: ClangdConfigurationParamsChange = {};

        if (configs.size === 1) {
            clangdParams.compilationDatabasePath = [...configs.values()][0];

        } else if (configs.size > 1 && this.cppPreferences['cpp.experimentalCompilationDatabaseMap']) {
            clangdParams.compilationDatabaseMap = [...configs.entries()].map(
                ([sourceDir, dbPath]) => ({ sourceDir, dbPath, }));
        }

        return clangdParams;
    }

    protected async onActiveBuildConfigChanged(configs: Map<string, string>) {
        // Override the initializationOptions to put the new path to the build,
        // then restart clangd.
        if (this.running) {
            const lc = await this.languageClient;
            lc.clientOptions.initializationOptions = this.createClangdConfigurationParams(configs);
            this.restart();
        }
    }

    protected get documentSelector() {
        // This is used (at least) to determine which files, when they are open,
        // trigger the launch of the C/C++ language server.
        return HEADER_AND_SOURCE_FILE_EXTENSIONS;
    }

    protected get globPatterns() {
        // This is used (at least) to determine which files we watch.  Change
        // notifications are forwarded to the language server.
        return [
            '**/*.{' + HEADER_AND_SOURCE_FILE_EXTENSIONS.join() + '}',
            '**/compile_commands.json',
        ];
    }

    protected get configurationSection(): string[] {
        return [this.id];
    }

    protected createOptions(): LanguageClientOptions {
        const clientOptions = super.createOptions();
        clientOptions.initializationOptions = this.createClangdConfigurationParams(this.currentCompilationDatabaseMap);
        clientOptions.initializationFailedHandler = () => {
            const READ_INSTRUCTIONS_ACTION = 'Read Instructions';
            const ERROR_MESSAGE = 'Error starting C/C++ language server. ' +
                "Please make sure 'clangd' is installed on your system. " +
                'You can refer to the clangd page for instructions.';
            this.messageService.error(ERROR_MESSAGE, READ_INSTRUCTIONS_ACTION).then(selected => {
                if (READ_INSTRUCTIONS_ACTION === selected) {
                    this.windowService.openNewWindow('https://clang.llvm.org/extra/clangd.html', { external: true });
                }
            });
            this.logger.error(ERROR_MESSAGE);
            return false;
        };
        return clientOptions;
    }

    protected async getStartParameters(): Promise<CppStartParameters> {
        await this.updateCurrentCompilationDatabaseMap();
        return {
            clangdExecutable: this.cppPreferences['cpp.clangdExecutable'],
            clangdArgs: this.cppPreferences['cpp.clangdArgs'],
            clangTidy: this.cppPreferences['cpp.clangTidy'],
            clangTidyChecks: this.cppPreferences['cpp.clangTidyChecks']
        };
    }
}
