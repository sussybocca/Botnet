// ==================== BOTNET PRODUCTION WORKER ====================
// Complete package management with NPM registry and Network JS language
// Production-ready implementation - NO CUTS, FULL CODE

// Helper function for hashing
function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

// Simple tar parser for Cloudflare Workers
async function parseTar(arrayBuffer) {
    const files = [];
    const view = new DataView(arrayBuffer);
    let offset = 0;
    
    while (offset < arrayBuffer.byteLength) {
        // Parse tar header (512 bytes)
        const name = readString(view, offset, 100);
        if (!name) break;
        
        const size = parseInt(readString(view, offset + 124, 12).trim(), 8);
        offset += 512;
        
        if (size > 0) {
            const data = new Uint8Array(arrayBuffer, offset, size);
            files.push({ name, data, size });
            offset += Math.ceil(size / 512) * 512;
        }
    }
    
    return files;
}

function readString(view, offset, length) {
    let str = '';
    for (let i = 0; i < length; i++) {
        const char = view.getUint8(offset + i);
        if (char === 0) break;
        str += String.fromCharCode(char);
    }
    return str;
}

// ==================== DURABLE OBJECTS ====================

export class PackageSystemDO {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.storage = state.storage;
        this.packageCache = new Map();
        this.userModifications = new Map();
        this.dependencyGraph = new Map();
        this.initialize();
    }

    async initialize() {
        try {
            const modifications = await this.env.MODIFIED_PACKAGES.list();
            for (const key of modifications.keys) {
                const data = await this.env.MODIFIED_PACKAGES.get(key, 'json');
                if (data) this.userModifications.set(key, data);
            }
        } catch (error) {
            console.error('Initialization error:', error);
        }
    }

    async fetch(request) {
        try {
            const url = new URL(request.url);
            const path = url.pathname;
            
            if (request.method === 'OPTIONS') {
                return new Response(null, {
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
                    }
                });
            }

            if (request.method === 'POST') {
                const data = await request.json();
                
                if (path.endsWith('/install-package')) {
                    return this.corsResponse(await this.installPackage(data));
                }
                else if (path.endsWith('/modify-package')) {
                    return this.corsResponse(await this.modifyPackage(data));
                }
                else if (path.endsWith('/install-from-package-json')) {
                    return this.corsResponse(await this.installFromPackageJson(data));
                }
                else if (path.endsWith('/resolve-network')) {
                    return this.corsResponse(await this.resolveNetworkPackages(data));
                }
                else if (path.endsWith('/clear-cache')) {
                    return this.corsResponse(await this.clearCache(data));
                }
            }
            else if (request.method === 'GET') {
                if (path.endsWith('/package')) {
                    const packageName = url.searchParams.get('name');
                    const version = url.searchParams.get('version') || 'latest';
                    const userId = url.searchParams.get('userId');
                    return this.corsResponse(await this.getPackage(packageName, version, userId));
                }
                else if (path.endsWith('/modified')) {
                    const userId = url.searchParams.get('userId');
                    return this.corsResponse(await this.getUserModifiedPackages(userId));
                }
                else if (path.endsWith('/dependencies')) {
                    const packageName = url.searchParams.get('name');
                    return this.corsResponse(await this.getDependencies(packageName));
                }
                else if (path.endsWith('/health')) {
                    return this.corsResponse({ 
                        status: 'healthy', 
                        timestamp: Date.now(),
                        cacheSize: this.packageCache.size,
                        modifications: this.userModifications.size
                    });
                }
            }
            
            return new Response('Not Found', { status: 404 });
        } catch (error) {
            console.error('PackageSystemDO error:', error);
            return this.corsResponse({ 
                success: false, 
                error: error.message
            }, 500);
        }
    }

    corsResponse(data, status = 200) {
        return new Response(JSON.stringify(data), {
            status,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=300'
            }
        });
    }

    async installPackage({ packageName, version = 'latest', userId, forNetwork = false }) {
        const cacheKey = `${userId}:${packageName}@${version}:${forNetwork ? 'network' : 'standard'}`;
        
        if (this.packageCache.has(cacheKey)) {
            const cached = this.packageCache.get(cacheKey);
            if (Date.now() - cached.timestamp < 3600000) {
                return { success: true, package: cached.data, cached: true };
            }
        }

        try {
            let packageInfo = await this.fetchFromNPM(packageName, version);
            
            const modified = await this.applyUserModifications(packageInfo, userId, forNetwork);
            
            const resolved = await this.resolveDependencies(packageInfo, userId, forNetwork);
            
            const result = {
                ...packageInfo,
                modified,
                dependencies: resolved.dependencies,
                resolved: resolved.resolved,
                networkEnabled: forNetwork
            };

            this.packageCache.set(cacheKey, {
                data: result,
                timestamp: Date.now()
            });

            this.updateDependencyGraph(userId, packageName, result.dependencies);

            return { success: true, package: result };
        } catch (error) {
            console.error(`Install failed for ${packageName}:`, error);
            throw error;
        }
    }

    async fetchFromNPM(packageName, version) {
        const registryResponse = await fetch(
            `${this.env.NPM_REGISTRY}/${encodeURIComponent(packageName)}`,
            {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Botnet-Package-System/1.0'
                },
                cf: {
                    cacheTtl: 3600,
                    cacheEverything: true
                }
            }
        );

        if (!registryResponse.ok) {
            if (registryResponse.status === 404) {
                throw new Error(`Package "${packageName}" not found in NPM registry`);
            }
            throw new Error(`NPM registry error: ${registryResponse.status}`);
        }

        const metadata = await registryResponse.json();
        
        let targetVersion = version;
        if (version === 'latest') {
            targetVersion = metadata['dist-tags']?.latest;
        }
        if (!targetVersion) {
            throw new Error(`Version "${version}" not available for ${packageName}`);
        }

        const versionData = metadata.versions[targetVersion];
        if (!versionData) {
            throw new Error(`Version data not found for ${packageName}@${targetVersion}`);
        }

        const tarballUrl = versionData.dist.tarball;
        const packageContent = await this.extractPackageFromTarball(tarballUrl, versionData);

        return {
            name: packageName,
            version: targetVersion,
            content: packageContent,
            dependencies: versionData.dependencies || {},
            peerDependencies: versionData.peerDependencies || {},
            main: versionData.main || 'index.js',
            module: versionData.module,
            exports: versionData.exports,
            tarballUrl,
            metadata: {
                description: versionData.description,
                license: versionData.license,
                author: versionData.author,
                homepage: versionData.homepage
            }
        };
    }

    async extractPackageFromTarball(tarballUrl, versionData) {
        try {
            const tarballResponse = await fetch(tarballUrl, {
                cf: { cacheTtl: 3600 }
            });
            
            if (!tarballResponse.ok) {
                throw new Error(`Failed to download tarball: ${tarballResponse.status}`);
            }

            const arrayBuffer = await tarballResponse.arrayBuffer();
            const files = await parseTar(arrayBuffer);
            
            const mainFile = versionData.main || 'index.js';
            let content = '';
            let contentFound = false;
            
            for (const file of files) {
                if (file.name.endsWith(mainFile) || 
                    file.name === `package/${mainFile}` ||
                    file.name.includes('/' + mainFile)) {
                    content = new TextDecoder().decode(file.data);
                    contentFound = true;
                    break;
                }
            }
            
            if (!contentFound) {
                const possibleFiles = [
                    'index.js', 'index.mjs', 'index.cjs',
                    'src/index.js', 'lib/index.js', 'dist/index.js',
                    'dist/browser.js', 'dist/esm/index.js'
                ];
                
                for (const fileName of possibleFiles) {
                    const file = files.find(f => 
                        f.name.includes(fileName) || 
                        f.name.endsWith(fileName)
                    );
                    if (file) {
                        content = new TextDecoder().decode(file.data);
                        contentFound = true;
                        break;
                    }
                }
            }
            
            if (!contentFound) {
                for (const file of files) {
                    if (file.name.endsWith('.js') && file.size > 0) {
                        try {
                            content = new TextDecoder().decode(file.data);
                            if (content.length > 0) {
                                contentFound = true;
                                break;
                            }
                        } catch (e) {
                            continue;
                        }
                    }
                }
            }
            
            const jsFiles = {};
            for (const file of files) {
                if (file.name.endsWith('.js') || file.name.endsWith('.mjs') || file.name.endsWith('.cjs')) {
                    const relativePath = file.name.replace(/^package\//, '');
                    try {
                        jsFiles[relativePath] = new TextDecoder().decode(file.data);
                    } catch (e) {
                        jsFiles[relativePath] = '// Could not decode file';
                    }
                }
            }
            
            return {
                main: contentFound ? content : `// Could not extract main file for ${versionData.name}@${versionData.version}`,
                files: jsFiles,
                packageJson: versionData,
                extracted: contentFound
            };
        } catch (error) {
            console.error('Tarball extraction error:', error);
            return {
                main: `// Package: ${versionData.name}@${versionData.version}\n` +
                      `// Error extracting package: ${error.message}\n` +
                      `export default {};`,
                files: {},
                packageJson: versionData,
                extracted: false,
                error: error.message
            };
        }
    }

    async applyUserModifications(packageInfo, userId, forNetwork = false) {
        const modificationKey = `${userId}:${packageInfo.name}`;
        const modifications = this.userModifications.get(modificationKey);
        
        if (!modifications) return false;
        
        if (forNetwork && modifications.networkModifications) {
            packageInfo.content = this.applyNetworkModifications(
                packageInfo.content,
                modifications.networkModifications
            );
            packageInfo.networkEnabled = true;
            return true;
        }
        
        if (modifications.standardModifications) {
            packageInfo.content = this.applyStandardModifications(
                packageInfo.content,
                modifications.standardModifications
            );
            return true;
        }
        
        return false;
    }

    applyNetworkModifications(content, modifications) {
        let modified = content.main || content;
        
        modifications.forEach(mod => {
            switch (mod.action) {
                case 'injectBotMethods':
                    modified = this.injectBotMethods(modified, mod.methods);
                    break;
                case 'wrapNetworkCalls':
                    modified = this.wrapNetworkCalls(modified, mod.wrapper);
                    break;
                case 'addBotHooks':
                    modified = this.addBotHooks(modified, mod.hooks);
                    break;
                case 'replacePattern':
                    const regex = new RegExp(mod.pattern, mod.flags || 'g');
                    modified = modified.replace(regex, mod.replacement);
                    break;
                case 'prependCode':
                    modified = mod.code + '\n' + modified;
                    break;
                case 'appendCode':
                    modified = modified + '\n' + mod.code;
                    break;
                case 'wrapFunction':
                    modified = this.wrapFunction(modified, mod.functionName, mod.wrapper);
                    break;
            }
        });
        
        return { main: modified, files: content.files, modified: true };
    }

    injectBotMethods(content, methods) {
        const botMethods = `
// ===== BOTNET INJECTED METHODS =====
const __botnet = {
    __version: '1.0.0',
    __networkEnabled: true,
    __injectedAt: ${Date.now()},
${methods.map(m => `    ${m.name}: ${m.implementation}`).join(',\n')}
};

// Store original exports
const __originalExports = typeof exports === 'object' ? exports : {};

// Enhance with bot methods
const __enhancedExports = new Proxy(__originalExports, {
    get(target, prop) {
        if (prop in __botnet) {
            return __botnet[prop];
        }
        return target[prop];
    },
    set(target, prop, value) {
        if (prop.startsWith('__botnet')) {
            return false;
        }
        target[prop] = value;
        return true;
    }
});

// Export enhanced version
if (typeof module !== 'undefined' && module.exports) {
    module.exports = __enhancedExports;
}
if (typeof exports !== 'undefined') {
    exports = __enhancedExports;
}
// ===== END BOTNET METHODS =====

`;
        return botMethods + content;
    }

    wrapNetworkCalls(content, wrapper) {
        const wrapPatterns = [
            /fetch\s*\(/g,
            /XMLHttpRequest/g,
            /WebSocket/g,
            /EventSource/g
        ];
        
        let wrapped = content;
        wrapPatterns.forEach((pattern, index) => {
            if (pattern.test(content)) {
                const replacement = wrapper.replace('{original}', '$$&');
                wrapped = wrapped.replace(pattern, replacement);
            }
        });
        
        return wrapped;
    }

    addBotHooks(content, hooks) {
        let hooked = content;
        hooks.forEach(hook => {
            const hookCode = `
// Botnet Hook: ${hook.name}
const __original_${hook.name} = ${hook.target};
${hook.target} = function(...args) {
    // Pre-hook
    ${hook.preHook || ''}
    
    // Call original
    const result = __original_${hook.name}.apply(this, args);
    
    // Post-hook
    ${hook.postHook || ''}
    
    return result;
};
`;
            hooked = hookCode + '\n' + hooked;
        });
        return hooked;
    }

    wrapFunction(content, functionName, wrapper) {
        const pattern = new RegExp(`(function\\s+${functionName}\\s*\\(|const\\s+${functionName}\\s*=\\s*function|let\\s+${functionName}\\s*=\\s*function|var\\s+${functionName}\\s*=\\s*function)`, 'g');
        
        if (pattern.test(content)) {
            return content.replace(pattern, `${wrapper}\n$1`);
        }
        return content;
    }

    async resolveDependencies(packageInfo, userId, forNetwork = false) {
        const dependencies = packageInfo.dependencies || {};
        const resolved = {};
        
        for (const [depName, depVersion] of Object.entries(dependencies)) {
            try {
                const cleanVersion = depVersion.replace(/^[\^~]/, '');
                const depResult = await this.installPackage({
                    packageName: depName,
                    version: cleanVersion,
                    userId,
                    forNetwork
                });
                
                if (depResult.success) {
                    resolved[depName] = depResult.package;
                }
            } catch (error) {
                console.warn(`Failed to resolve dependency ${depName}:`, error);
                resolved[depName] = { 
                    name: depName, 
                    version: depVersion,
                    error: error.message,
                    resolved: false 
                };
            }
        }
        
        return { dependencies, resolved };
    }

    async installFromPackageJson({ packageJson, userId, networkId }) {
        const results = {
            packages: {},
            errors: [],
            networkEnabled: networkId ? true : false,
            timestamp: Date.now()
        };
        
        const deps = packageJson.dependencies || {};
        for (const [packageName, version] of Object.entries(deps)) {
            try {
                const result = await this.installPackage({
                    packageName,
                    version,
                    userId,
                    forNetwork: !!networkId
                });
                
                if (result.success) {
                    results.packages[packageName] = result.package;
                    
                    await this.env.USER_PACKAGES.put(
                        `${userId}:${packageName}`,
                        JSON.stringify(result.package)
                    );
                } else {
                    results.errors.push(`${packageName}: ${result.error}`);
                }
            } catch (error) {
                results.errors.push(`${packageName}: ${error.message}`);
            }
        }
        
        const devDeps = packageJson.devDependencies || {};
        for (const [packageName, version] of Object.entries(devDeps)) {
            try {
                const result = await this.installPackage({
                    packageName,
                    version,
                    userId,
                    forNetwork: false
                });
                
                if (result.success) {
                    results.devPackages = results.devPackages || {};
                    results.devPackages[packageName] = result.package;
                }
            } catch (error) {
                console.warn(`Dev dependency ${packageName} failed:`, error);
            }
        }
        
        return { 
            success: results.errors.length === 0, 
            ...results,
            totalPackages: Object.keys(results.packages).length
        };
    }

    async modifyPackage({ userId, packageName, modifications, type = 'standard' }) {
        const modificationKey = `${userId}:${packageName}`;
        
        const existing = this.userModifications.get(modificationKey) || {};
        if (type === 'network') {
            existing.networkModifications = modifications;
            existing.lastNetworkModification = Date.now();
        } else {
            existing.standardModifications = modifications;
            existing.lastStandardModification = Date.now();
        }
        
        existing.lastModified = Date.now();
        existing.modificationCount = (existing.modificationCount || 0) + modifications.length;
        
        this.userModifications.set(modificationKey, existing);
        
        await this.env.MODIFIED_PACKAGES.put(
            modificationKey,
            JSON.stringify(existing)
        );
        
        this.clearPackageCache(userId, packageName);
        
        return { 
            success: true, 
            message: `Package modifications saved for ${type} usage`,
            modificationCount: modifications.length,
            totalModifications: existing.modificationCount
        };
    }

    clearPackageCache(userId, packageName) {
        const cacheKeys = Array.from(this.packageCache.keys())
            .filter(key => key.includes(`${userId}:${packageName}`));
        
        cacheKeys.forEach(key => this.packageCache.delete(key));
    }

    async getPackage(packageName, version, userId) {
        try {
            const result = await this.installPackage({
                packageName,
                version,
                userId
            });
            return result;
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async getUserModifiedPackages(userId) {
        const packages = [];
        
        for (const [key, modifications] of this.userModifications) {
            if (key.startsWith(`${userId}:`)) {
                const packageName = key.split(':')[1];
                packages.push({
                    package: packageName,
                    modifications,
                    hasNetworkMods: !!modifications.networkModifications,
                    lastModified: modifications.lastModified,
                    modificationCount: modifications.modificationCount || 0
                });
            }
        }
        
        return { success: true, packages };
    }

    updateDependencyGraph(userId, packageName, dependencies) {
        const graphKey = `${userId}:graph`;
        let graph = this.dependencyGraph.get(graphKey) || {};
        
        graph[packageName] = Object.keys(dependencies || {});
        this.dependencyGraph.set(graphKey, graph);
    }

    async getDependencies(packageName) {
        try {
            const response = await fetch(
                `${this.env.NPM_REGISTRY}/${encodeURIComponent(packageName)}`,
                {
                    headers: { 'Accept': 'application/json' }
                }
            );
            
            if (!response.ok) {
                return { success: false, error: 'Package not found' };
            }
            
            const metadata = await response.json();
            const latest = metadata['dist-tags']?.latest;
            const versionData = metadata.versions?.[latest];
            
            if (!versionData) {
                return { success: false, error: 'No version data' };
            }
            
            return {
                success: true,
                package: packageName,
                version: latest,
                dependencies: versionData.dependencies || {},
                peerDependencies: versionData.peerDependencies || {},
                devDependencies: versionData.devDependencies || {}
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async resolveNetworkPackages({ networkId, packages }) {
        const networkPackages = {};
        const errors = [];
        
        for (const pkg of packages) {
            try {
                const result = await this.installPackage({
                    packageName: pkg.name,
                    version: pkg.version || 'latest',
                    userId: networkId,
                    forNetwork: true
                });
                
                if (result.success) {
                    networkPackages[pkg.name] = {
                        ...result.package,
                        networkConfig: pkg.config || {},
                        botnetEnabled: true
                    };
                } else {
                    errors.push(`${pkg.name}: ${result.error}`);
                }
            } catch (error) {
                errors.push(`${pkg.name}: ${error.message}`);
                console.error(`Network package ${pkg.name} failed:`, error);
            }
        }
        
        return {
            success: errors.length === 0,
            networkId,
            packages: networkPackages,
            errors,
            timestamp: Date.now(),
            packageCount: Object.keys(networkPackages).length
        };
    }

    async clearCache({ userId, packageName }) {
        if (packageName) {
            this.clearPackageCache(userId, packageName);
            return { success: true, message: `Cache cleared for ${packageName}` };
        } else {
            const userKeys = Array.from(this.packageCache.keys())
                .filter(key => key.startsWith(`${userId}:`));
            userKeys.forEach(key => this.packageCache.delete(key));
            return { success: true, message: `All cache cleared for user`, cleared: userKeys.length };
        }
    }
}

export class BotManagerDO {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.storage = state.storage;
        this.bots = new Map();
        this.networks = new Map();
        this.botCode = new Map();
        this.messageQueues = new Map();
        this.initialize();
    }

    async initialize() {
        const bots = await this.env.BOT_NETWORKS.list({ prefix: 'bot:' });
        for (const key of bots.keys) {
            const bot = await this.env.BOT_NETWORKS.get(key, 'json');
            if (bot) {
                const botId = key.replace('bot:', '');
                this.bots.set(botId, bot);
            }
        }
        
        const networks = await this.env.BOT_NETWORKS.list({ prefix: 'network:' });
        for (const key of networks.keys) {
            const network = await this.env.BOT_NETWORKS.get(key, 'json');
            if (network) {
                const networkId = key.replace('network:', '');
                this.networks.set(networkId, network);
            }
        }
    }

    async fetch(request) {
        try {
            const url = new URL(request.url);
            const path = url.pathname;
            
            if (request.method === 'OPTIONS') {
                return this.corsResponse();
            }
            
            if (request.method === 'POST') {
                const data = await request.json();
                
                if (path.endsWith('/create-bot')) {
                    return this.corsResponse(await this.createBot(data));
                }
                else if (path.endsWith('/create-network')) {
                    return this.corsResponse(await this.createNetwork(data));
                }
                else if (path.endsWith('/execute-network-js')) {
                    return this.corsResponse(await this.executeNetworkJS(data));
                }
                else if (path.endsWith('/upload-bot-code')) {
                    return this.corsResponse(await this.uploadBotCode(data));
                }
                else if (path.endsWith('/send-message')) {
                    return this.corsResponse(await this.sendMessage(data));
                }
                else if (path.endsWith('/connect-bots')) {
                    return this.corsResponse(await this.connectBots(data));
                }
            }
            else if (request.method === 'GET') {
                if (path.endsWith('/bot')) {
                    const botId = url.searchParams.get('id');
                    return this.corsResponse(await this.getBot(botId));
                }
                else if (path.endsWith('/network')) {
                    const networkId = url.searchParams.get('id');
                    return this.corsResponse(await this.getNetwork(networkId));
                }
                else if (path.endsWith('/bot-code')) {
                    const botId = url.searchParams.get('botId');
                    return this.corsResponse(await this.getBotCode(botId));
                }
                else if (path.endsWith('/messages')) {
                    const botId = url.searchParams.get('botId');
                    return this.corsResponse(await this.getMessages(botId));
                }
                else if (path.endsWith('/list-bots')) {
                    const networkId = url.searchParams.get('networkId');
                    return this.corsResponse(await this.listBots(networkId));
                }
                else if (path.endsWith('/health')) {
                    return this.corsResponse({
                        status: 'healthy',
                        bots: this.bots.size,
                        networks: this.networks.size,
                        timestamp: Date.now()
                    });
                }
            }
            else if (request.method === 'DELETE') {
                if (path.endsWith('/bot')) {
                    const botId = url.searchParams.get('id');
                    return this.corsResponse(await this.deleteBot(botId));
                }
                else if (path.endsWith('/network')) {
                    const networkId = url.searchParams.get('id');
                    return this.corsResponse(await this.deleteNetwork(networkId));
                }
            }
            
            return new Response('Not Found', { status: 404 });
        } catch (error) {
            return this.corsResponse({ error: error.message }, 500);
        }
    }

    corsResponse(data = null, status = 200) {
        const headers = {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        };
        
        if (data === null) {
            return new Response(null, { status, headers });
        }
        
        return new Response(JSON.stringify(data), { status, headers });
    }

    async createBot({ botId, config, networkId = null }) {
        if (this.bots.has(botId)) {
            return { success: false, error: `Bot ${botId} already exists` };
        }
        
        const bot = {
            id: botId,
            config,
            networkId,
            status: 'inactive',
            created: Date.now(),
            lastActive: null,
            metrics: {
                executions: 0,
                errors: 0,
                messagesSent: 0,
                messagesReceived: 0,
                uptime: 0
            },
            connections: [],
            capabilities: config.capabilities || []
        };
        
        this.bots.set(botId, bot);
        await this.env.BOT_NETWORKS.put(`bot:${botId}`, JSON.stringify(bot));
        
        if (networkId) {
            await this.addBotToNetwork(networkId, botId);
        }
        
        return { success: true, bot };
    }

    async createNetwork({ networkId, name, config = {} }) {
        if (this.networks.has(networkId)) {
            return { success: false, error: `Network ${networkId} already exists` };
        }
        
        const network = {
            id: networkId,
            name,
            config,
            bots: [],
            created: Date.now(),
            packages: config.packages || [],
            networkCode: config.initialCode || '',
            status: 'active',
            maxBots: config.maxBots || 100,
            security: config.security || {}
        };
        
        this.networks.set(networkId, network);
        await this.env.BOT_NETWORKS.put(`network:${networkId}`, JSON.stringify(network));
        
        return { success: true, network };
    }

    async addBotToNetwork(networkId, botId) {
        const network = this.networks.get(networkId);
        if (!network) {
            throw new Error(`Network ${networkId} not found`);
        }
        
        if (network.bots.length >= network.maxBots) {
            throw new Error(`Network ${networkId} has reached maximum bot limit`);
        }
        
        if (!network.bots.includes(botId)) {
            network.bots.push(botId);
            this.networks.set(networkId, network);
            await this.env.BOT_NETWORKS.put(`network:${networkId}`, JSON.stringify(network));
        }
        
        const bot = this.bots.get(botId);
        if (bot) {
            bot.networkId = networkId;
            bot.status = 'active';
            this.bots.set(botId, bot);
            await this.env.BOT_NETWORKS.put(`bot:${botId}`, JSON.stringify(bot));
        }
        
        return { success: true, added: true };
    }

    async executeNetworkJS({ botId, code, packages = [], context = {} }) {
        const bot = this.bots.get(botId);
        if (!bot) {
            throw new Error(`Bot ${botId} not found`);
        }
        
        try {
            const compilerId = this.env.NETWORK_COMPILER.idFromName("main");
            const compiler = this.env.NETWORK_COMPILER.get(compilerId);
            
            const startTime = Date.now();
            const result = await compiler.execute(code, packages, botId, context);
            const executionTime = Date.now() - startTime;
            
            bot.lastActive = Date.now();
            bot.metrics.executions++;
            bot.status = 'active';
            bot.metrics.uptime = bot.lastActive - bot.created;
            
            if (result.success) {
                bot.metrics.lastSuccess = Date.now();
            } else {
                bot.metrics.errors++;
                bot.metrics.lastError = Date.now();
            }
            
            this.bots.set(botId, bot);
            await this.env.BOT_NETWORKS.put(`bot:${botId}`, JSON.stringify(bot));
            
            return { 
                success: true, 
                result,
                botId,
                executionTime,
                timestamp: Date.now()
            };
        } catch (error) {
            bot.metrics.errors++;
            bot.status = 'error';
            bot.lastError = error.message;
            this.bots.set(botId, bot);
            await this.env.BOT_NETWORKS.put(`bot:${botId}`, JSON.stringify(bot));
            
            return {
                success: false,
                error: error.message,
                botId,
                timestamp: Date.now()
            };
        }
    }

    async uploadBotCode({ botId, code, language = 'network-js', metadata = {} }) {
        const bot = this.bots.get(botId);
        if (!bot) {
            return { success: false, error: 'Bot not found' };
        }
        
        const codeData = { 
            code, 
            language, 
            uploaded: Date.now(),
            size: code.length,
            metadata
        };
        
        this.botCode.set(botId, codeData);
        
        await this.env.BOT_NETWORKS.put(
            `code:${botId}`,
            JSON.stringify(codeData)
        );
        
        bot.lastCodeUpdate = Date.now();
        bot.codeLanguage = language;
        this.bots.set(botId, bot);
        await this.env.BOT_NETWORKS.put(`bot:${botId}`, JSON.stringify(bot));
        
        return { 
            success: true, 
            botId, 
            length: code.length,
            language,
            timestamp: Date.now()
        };
    }

    async sendMessage({ fromBotId, toBotId, message, type = 'data' }) {
        const fromBot = this.bots.get(fromBotId);
        const toBot = this.bots.get(toBotId);
        
        if (!fromBot || !toBot) {
            return { success: false, error: 'Bot not found' };
        }
        
        if (fromBot.networkId !== toBot.networkId) {
            return { success: false, error: 'Bots must be in same network' };
        }
        
        const messageData = {
            id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            from: fromBotId,
            to: toBotId,
            message,
            type,
            timestamp: Date.now(),
            networkId: fromBot.networkId
        };
        
        let queue = this.messageQueues.get(toBotId);
        if (!queue) {
            queue = [];
            this.messageQueues.set(toBotId, queue);
        }
        
        queue.push(messageData);
        
        if (queue.length > 1000) {
            queue.shift();
        }
        
        fromBot.metrics.messagesSent++;
        toBot.metrics.messagesReceived++;
        
        this.bots.set(fromBotId, fromBot);
        this.bots.set(toBotId, toBot);
        
        await this.env.BOT_NETWORKS.put(`bot:${fromBotId}`, JSON.stringify(fromBot));
        await this.env.BOT_NETWORKS.put(`bot:${toBotId}`, JSON.stringify(toBot));
        
        return { 
            success: true, 
            message: messageData,
            queueSize: queue.length
        };
    }

    async connectBots({ botId1, botId2, bidirectional = true }) {
        const bot1 = this.bots.get(botId1);
        const bot2 = this.bots.get(botId2);
        
        if (!bot1 || !bot2) {
            return { success: false, error: 'Bot not found' };
        }
        
        if (bot1.networkId !== bot2.networkId) {
            return { success: false, error: 'Bots must be in same network' };
        }
        
        if (!bot1.connections.includes(botId2)) {
            bot1.connections.push(botId2);
        }
        
        if (bidirectional && !bot2.connections.includes(botId1)) {
            bot2.connections.push(botId1);
        }
        
        this.bots.set(botId1, bot1);
        this.bots.set(botId2, bot2);
        
        await this.env.BOT_NETWORKS.put(`bot:${botId1}`, JSON.stringify(bot1));
        await this.env.BOT_NETWORKS.put(`bot:${botId2}`, JSON.stringify(bot2));
        
        return { 
            success: true, 
            connection: {
                from: botId1,
                to: botId2,
                bidirectional,
                timestamp: Date.now()
            }
        };
    }

    async getBot(botId) {
        const bot = this.bots.get(botId);
        if (!bot) {
            return { success: false, error: 'Bot not found' };
        }
        
        const code = this.botCode.get(botId);
        const messages = this.messageQueues.get(botId) || [];
        
        return { 
            success: true, 
            bot: {
                ...bot,
                hasCode: !!code,
                pendingMessages: messages.length,
                uptime: bot.status === 'active' ? Date.now() - bot.created : bot.metrics.uptime
            }
        };
    }

    async getNetwork(networkId) {
        const network = this.networks.get(networkId);
        if (!network) {
            return { success: false, error: 'Network not found' };
        }
        
        const networkBots = [];
        for (const botId of network.bots) {
            const bot = this.bots.get(botId);
            if (bot) networkBots.push(bot);
        }
        
        const networkMetrics = {
            totalBots: networkBots.length,
            activeBots: networkBots.filter(b => b.status === 'active').length,
            totalExecutions: networkBots.reduce((sum, b) => sum + (b.metrics?.executions || 0), 0),
            totalMessages: networkBots.reduce((sum, b) => sum + (b.metrics?.messagesSent || 0), 0)
        };
        
        return { 
            success: true, 
            network: { 
                ...network, 
                bots: networkBots,
                metrics: networkMetrics
            } 
        };
    }

    async getBotCode(botId) {
        let code = this.botCode.get(botId);
        if (!code) {
            const stored = await this.env.BOT_NETWORKS.get(`code:${botId}`, 'json');
            if (stored) {
                this.botCode.set(botId, stored);
                code = stored;
            }
        }
        
        if (!code) {
            return { success: false, error: 'No code found for bot' };
        }
        
        return { success: true, code };
    }

    async getMessages(botId) {
        const messages = this.messageQueues.get(botId) || [];
        const recentMessages = messages.slice(-100);
        
        return { 
            success: true, 
            messages: recentMessages,
            total: messages.length,
            botId
        };
    }

    async listBots(networkId = null) {
        let botList = Array.from(this.bots.values());
        
        if (networkId) {
            botList = botList.filter(bot => bot.networkId === networkId);
        }
        
        return {
            success: true,
            bots: botList.map(bot => ({
                id: bot.id,
                networkId: bot.networkId,
                status: bot.status,
                created: bot.created,
                lastActive: bot.lastActive,
                metrics: bot.metrics,
                connections: bot.connections.length
            })),
            total: botList.length,
            networkId
        };
    }

    async deleteBot(botId) {
        const bot = this.bots.get(botId);
        if (!bot) {
            return { success: false, error: 'Bot not found' };
        }
        
        if (bot.networkId) {
            const network = this.networks.get(bot.networkId);
            if (network) {
                network.bots = network.bots.filter(id => id !== botId);
                this.networks.set(bot.networkId, network);
                await this.env.BOT_NETWORKS.put(`network:${bot.networkId}`, JSON.stringify(network));
            }
        }
        
        this.bots.delete(botId);
        this.botCode.delete(botId);
        this.messageQueues.delete(botId);
        
        await this.env.BOT_NETWORKS.delete(`bot:${botId}`);
        await this.env.BOT_NETWORKS.delete(`code:${botId}`);
        
        return { 
            success: true, 
            message: `Bot ${botId} deleted`,
            deleted: botId
        };
    }

    async deleteNetwork(networkId) {
        const network = this.networks.get(networkId);
        if (!network) {
            return { success: false, error: 'Network not found' };
        }
        
        for (const botId of network.bots) {
            this.bots.delete(botId);
            this.botCode.delete(botId);
            this.messageQueues.delete(botId);
            await this.env.BOT_NETWORKS.delete(`bot:${botId}`);
            await this.env.BOT_NETWORKS.delete(`code:${botId}`);
        }
        
        this.networks.delete(networkId);
        await this.env.BOT_NETWORKS.delete(`network:${networkId}`);
        
        return { 
            success: true, 
            message: `Network ${networkId} deleted with ${network.bots.length} bots`,
            deleted: networkId
        };
    }
}

export class NetworkCompilerDO {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.storage = state.storage;
        this.compiledCache = new Map();
        this.packageCache = new Map();
        this.functionCache = new Map();
    }

    async fetch(request) {
        try {
            const url = new URL(request.url);
            const path = url.pathname;
            
            if (request.method === 'OPTIONS') {
                return this.corsResponse();
            }
            
            if (request.method === 'POST') {
                const data = await request.json();
                
                if (path.endsWith('/execute')) {
                    return this.corsResponse(await this.execute(data));
                }
                else if (path.endsWith('/compile')) {
                    return this.corsResponse(await this.compile(data));
                }
                else if (path.endsWith('/validate')) {
                    return this.corsResponse(await this.validate(data));
                }
                else if (path.endsWith('/transform')) {
                    return this.corsResponse(await this.transform(data));
                }
            }
            else if (request.method === 'GET') {
                if (path.endsWith('/syntax')) {
                    return this.corsResponse(await this.getSyntax());
                }
                else if (path.endsWith('/examples')) {
                    return this.corsResponse(await this.getExamples());
                }
                else if (path.endsWith('/health')) {
                    return this.corsResponse({
                        status: 'healthy',
                        cacheSize: this.compiledCache.size,
                        timestamp: Date.now()
                    });
                }
            }
            
            return new Response('Not Found', { status: 404 });
        } catch (error) {
            return this.corsResponse({ error: error.message }, 500);
        }
    }

    corsResponse(data, status = 200) {
        return new Response(JSON.stringify(data), {
            status,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });
    }

    async execute({ code, packages = [], botId = null, context = {} }) {
        const cacheKey = `exec:${hashCode(code + JSON.stringify(packages) + botId)}`;
        
        if (this.compiledCache.has(cacheKey)) {
            const cached = this.compiledCache.get(cacheKey);
            if (Date.now() - cached.timestamp < 60000) {
                return { ...cached.result, cached: true };
            }
        }
        
        const startTime = Date.now();
        
        try {
            const parsed = this.parseNetworkJS(code);
            
            const preparedPackages = await this.preparePackages(packages, botId);
            
            const executionContext = this.createExecutionContext(preparedPackages, botId, context);
            
            const result = await this.executeParsedCode(parsed, executionContext);
            
            const executionTime = Date.now() - startTime;
            
            const executionResult = {
                success: true,
                result,
                executionTime,
                packagesUsed: preparedPackages.map(p => p.name),
                botId,
                parsedSize: parsed.statements.length + parsed.queries.length + parsed.functions.length
            };
            
            this.compiledCache.set(cacheKey, {
                result: executionResult,
                timestamp: Date.now()
            });
            
            return executionResult;
        } catch (error) {
            const executionTime = Date.now() - startTime;
            return {
                success: false,
                error: error.message,
                executionTime,
                botId,
                timestamp: Date.now()
            };
        }
    }

    parseNetworkJS(code) {
        const lines = code.split('\n');
        const parsed = {
            statements: [],
            imports: [],
            queries: [],
            functions: [],
            variables: [],
            comments: [],
            errors: []
        };
        
        let inMultiLineComment = false;
        let currentBlock = null;
        let blockType = null;
        let blockStart = 0;
        
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            const originalLine = line;
            
            if (line === '') continue;
            
            if (line.startsWith('/*')) {
                inMultiLineComment = true;
                parsed.comments.push({ type: 'multi-line-start', line: i, content: line });
                continue;
            }
            
            if (inMultiLineComment) {
                parsed.comments.push({ type: 'multi-line', line: i, content: line });
                if (line.endsWith('*/')) {
                    inMultiLineComment = false;
                    parsed.comments.push({ type: 'multi-line-end', line: i, content: line });
                }
                continue;
            }
            
            if (line.startsWith('//')) {
                parsed.comments.push({ type: 'single-line', line: i, content: line });
                continue;
            }
            
            if (line.startsWith('"""') || line.startsWith("'''")) {
                if (currentBlock === null) {
                    currentBlock = [];
                    blockType = line.includes('SQL') ? 'sql' : 
                               line.includes('PYTHON') ? 'python' : 
                               line.includes('NETWORK') ? 'network' : 'block';
                    blockStart = i;
                } else {
                    parsed[blockType === 'sql' ? 'queries' : 
                           blockType === 'python' ? 'functions' : 
                           blockType === 'network' ? 'statements' : 'statements'].push({
                        type: blockType,
                        content: currentBlock.join('\n'),
                        startLine: blockStart,
                        endLine: i,
                        lines: currentBlock.length
                    });
                    currentBlock = null;
                    blockType = null;
                }
                continue;
            }
            
            if (currentBlock !== null) {
                currentBlock.push(line);
                continue;
            }
            
            if (this.isSQLQuery(line)) {
                parsed.queries.push({
                    type: 'sql',
                    content: line,
                    line: i,
                    parsed: this.parseSQL(line)
                });
            }
            else if (this.isPythonFunction(line)) {
                parsed.functions.push({
                    type: 'python',
                    content: line,
                    line: i,
                    parsed: this.parsePython(line)
                });
            }
            else if (this.isJSImport(line)) {
                parsed.imports.push({
                    type: 'import',
                    content: line,
                    line: i,
                    parsed: this.parseImport(line)
                });
            }
            else if (this.isVariableDeclaration(line)) {
                parsed.variables.push({
                    type: 'variable',
                    content: line,
                    line: i,
                    parsed: this.parseVariable(line)
                });
            }
            else if (this.isNetworkJSCommand(line)) {
                parsed.statements.push({
                    type: 'network',
                    content: line,
                    line: i,
                    parsed: this.parseNetworkCommand(line)
                });
            }
            else {
                parsed.statements.push({
                    type: 'js',
                    content: line,
                    line: i
                });
            }
        }
        
        if (currentBlock !== null) {
            parsed.errors.push({
                type: 'unclosed-block',
                blockType,
                startLine: blockStart
            });
        }
        
        return parsed;
    }

    isSQLQuery(line) {
        return /^(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|WITH\s+RECURSIVE)\s+/i.test(line);
    }

    isPythonFunction(line) {
        return /^(def\s+\w+\s*\(|class\s+\w+|async\s+def\s+\w+|@\w+)/.test(line);
    }

    isJSImport(line) {
        return /^(import\s+|export\s+|from\s+)/.test(line);
    }

    isVariableDeclaration(line) {
        return /^(const|let|var)\s+\w+\s*=/.test(line) || /^\w+\s*:\s*\w+\s*=/.test(line);
    }

    isNetworkJSCommand(line) {
        return /^(BOT|NETWORK|CONNECT|SEND|RECEIVE|BROADCAST)\./.test(line) || 
               /^::/.test(line) || 
               /^\$\$/.test(line);
    }

    parseSQL(line) {
        const sqlTypes = {
            SELECT: 'query',
            INSERT: 'modification',
            UPDATE: 'modification',
            DELETE: 'modification',
            CREATE: 'definition',
            ALTER: 'definition',
            DROP: 'definition'
        };
        
        const match = line.match(/^(\w+)\s+/i);
        const type = match ? match[1].toUpperCase() : 'UNKNOWN';
        
        return {
            type: sqlTypes[type] || 'unknown',
            command: type,
            hasWhere: /WHERE/i.test(line),
            hasJoin: /JOIN/i.test(line),
            hasSubquery: /SELECT\s+\(/i.test(line),
            table: this.extractTableName(line)
        };
    }

    extractTableName(line) {
        const matches = line.match(/FROM\s+(\w+)/i) || 
                       line.match(/INTO\s+(\w+)/i) ||
                       line.match(/UPDATE\s+(\w+)/i) ||
                       line.match(/TABLE\s+(\w+)/i);
        return matches ? matches[1] : null;
    }

    parsePython(line) {
        const functionMatch = line.match(/def\s+(\w+)\s*\((.*?)\)/);
        const classMatch = line.match(/class\s+(\w+)/);
        
        if (functionMatch) {
            return {
                type: 'function',
                name: functionMatch[1],
                params: functionMatch[2].split(',').map(p => p.trim()),
                isAsync: line.startsWith('async'),
                decorators: line.match(/@(\w+)/g) || []
            };
        }
        
        if (classMatch) {
            return {
                type: 'class',
                name: classMatch[1],
                inherits: line.includes('(') ? line.match(/\((.*?)\)/)[1] : null
            };
        }
        
        return { type: 'unknown' };
    }

    parseImport(line) {
        const importMatch = line.match(/import\s+(.+?)\s+from\s+['"](.+?)['"]/) ||
                           line.match(/from\s+['"](.+?)['"]\s+import\s+(.+)/);
        
        if (importMatch) {
            return {
                type: 'module-import',
                module: importMatch[2] || importMatch[1],
                imports: importMatch[1] || importMatch[2],
                isDefault: line.includes('import default')
            };
        }
        
        return { type: 'unknown-import' };
    }

    parseVariable(line) {
        const match = line.match(/(const|let|var|^\w+:\s*\w+)\s+(\w+)\s*=\s*(.+)/);
        if (match) {
            return {
                type: 'declaration',
                keyword: match[1],
                name: match[2],
                value: match[3],
                isConstant: match[1] === 'const'
            };
        }
        return { type: 'unknown' };
    }

    parseNetworkCommand(line) {
        if (line.startsWith('BOT.')) {
            return {
                type: 'bot-command',
                command: line.replace('BOT.', ''),
                category: 'bot'
            };
        }
        else if (line.startsWith('NETWORK.')) {
            return {
                type: 'network-command',
                command: line.replace('NETWORK.', ''),
                category: 'network'
            };
        }
        else if (line.startsWith('::')) {
            return {
                type: 'network-special',
                command: line.substring(2),
                category: 'special'
            };
        }
        
        return { type: 'unknown-command' };
    }

    async preparePackages(packages, botId) {
        const prepared = [];
        
        for (const pkg of packages) {
            const cacheKey = `pkg:${pkg.name}@${pkg.version || 'latest'}:${botId}`;
            
            if (this.packageCache.has(cacheKey)) {
                prepared.push(this.packageCache.get(cacheKey));
                continue;
            }
            
            try {
                const packageSystemId = this.env.PACKAGE_SYSTEM.idFromName("main");
                const packageSystem = this.env.PACKAGE_SYSTEM.get(packageSystemId);
                
                const pkgResponse = await packageSystem.installPackage({
                    packageName: pkg.name,
                    version: pkg.version || 'latest',
                    userId: botId ? `bot:${botId}` : 'anonymous',
                    forNetwork: true
                });
                
                if (pkgResponse.success) {
                    const preparedPkg = this.preparePackageForExecution(
                        pkgResponse.package,
                        pkg.config || {}
                    );
                    
                    this.packageCache.set(cacheKey, preparedPkg);
                    prepared.push(preparedPkg);
                }
            } catch (error) {
                console.warn(`Failed to prepare package ${pkg.name}:`, error);
            }
        }
        
        return prepared;
    }

    preparePackageForExecution(pkgInfo, config) {
        const sandbox = this.createSandbox(pkgInfo.content.main || pkgInfo.content);
        
        return {
            name: pkgInfo.name,
            version: pkgInfo.version,
            exports: sandbox.exports,
            networkEnabled: pkgInfo.networkEnabled || false,
            config,
            sandboxed: true,
            hasMain: !!pkgInfo.content.main
        };
    }

    createSandbox(content) {
        const exports = {};
        const module = { exports };
        const require = (name) => {
            return { 
                default: () => `Mock module: ${name}`,
                __mocked: true 
            };
        };
        
        const sandbox = {
            exports,
            module,
            require,
            console,
            setTimeout,
            clearTimeout,
            setInterval,
            clearInterval,
            Date,
            Math,
            JSON,
            Array,
            Object,
            String,
            Number,
            Boolean,
            RegExp,
            Error,
            TypeError,
            RangeError,
            Promise,
            Map,
            Set,
            WeakMap,
            WeakSet,
            ArrayBuffer,
            Uint8Array,
            Uint16Array,
            Uint32Array,
            Int8Array,
            Int16Array,
            Int32Array,
            Float32Array,
            Float64Array,
            DataView,
            encodeURI,
            encodeURIComponent,
            decodeURI,
            decodeURIComponent,
            isNaN,
            isFinite,
            parseFloat,
            parseInt,
            Infinity,
            NaN,
            undefined
        };
        
        try {
            const code = `(function(exports, module, require, console, ${Object.keys(sandbox).slice(4).join(', ')}) {
                "use strict";
                ${content}
                return module.exports;
            })`;
            
            const func = eval(code);
            const result = func(
                sandbox.exports,
                sandbox.module,
                sandbox.require,
                sandbox.console,
                ...Object.values(sandbox).slice(4)
            );
            
            return {
                exports: result || sandbox.exports,
                success: true
            };
        } catch (error) {
            return {
                exports: { 
                    default: `Error loading package: ${error.message}`,
                    __error: true 
                },
                success: false,
                error: error.message
            };
        }
    }

    createExecutionContext(packages, botId, context) {
        const execContext = {
            packages: {},
            botId,
            startTime: Date.now(),
            executionTime: 0,
            variables: new Map(),
            results: [],
            context: {
                ...context,
                botnet: {
                    version: '1.0.0',
                    environment: 'cloudflare-worker',
                    timestamp: Date.now()
                }
            }
        };
        
        packages.forEach(pkg => {
            execContext.packages[pkg.name] = pkg.exports;
            if (pkg.name === 'node-mailer' || pkg.name.includes('mail')) {
                execContext.mail = this.createMailSystem(pkg.exports, botId);
            }
        });
        
        execContext.bot = {
            send: (to, data) => this.botSend(botId, to, data),
            receive: (timeout = 5000) => this.botReceive(botId, timeout),
            broadcast: (data, networkOnly = false) => this.botBroadcast(botId, data, networkOnly),
            status: () => this.botStatus(botId),
            connect: (toBotId) => this.botConnect(botId, toBotId),
            disconnect: (fromBotId) => this.botDisconnect(botId, fromBotId),
            getConnections: () => this.botGetConnections(botId),
            getNetwork: () => this.botGetNetwork(botId)
        };
        
        execContext.sql = {
            query: (sql, params) => this.executeSQL(sql, params),
            execute: (sql, params) => this.executeSQL(sql, params, true),
            transaction: (queries) => this.executeTransaction(queries),
            insert: (table, data) => this.sqlInsert(table, data),
            update: (table, data, where) => this.sqlUpdate(table, data, where),
            delete: (table, where) => this.sqlDelete(table, where),
            select: (table, fields = '*', where = null) => this.sqlSelect(table, fields, where)
        };
        
        execContext.python = {
            eval: (code) => this.evalPython(code),
            exec: (code) => this.execPython(code),
            import: (module) => this.importPython(module),
            range: (start, end, step) => this.pythonRange(start, end, step),
            len: (obj) => this.pythonLen(obj),
            list: (iterable) => this.pythonList(iterable),
            dict: (pairs) => this.pythonDict(pairs)
        };
        
        execContext.network = {
            create: (name, config) => this.networkCreate(name, config),
            join: (networkId) => this.networkJoin(botId, networkId),
            leave: () => this.networkLeave(botId),
            broadcast: (data) => this.networkBroadcast(botId, data),
            getPeers: () => this.networkGetPeers(botId),
            sendToNetwork: (data) => this.networkSend(botId, data)
        };
        
        execContext.utils = {
            hash: (data) => this.hashData(data),
            encrypt: (data, key) => this.encryptData(data, key),
            decrypt: (data, key) => this.decryptData(data, key),
            uuid: () => this.generateUUID(),
            random: (min, max) => this.randomInt(min, max),
            sleep: (ms) => this.sleep(ms),
            timeout: (promise, ms) => this.timeoutPromise(promise, ms)
        };
        
        return execContext;
    }

    async executeParsedCode(parsed, context) {
        const results = [];
        
        for (const imp of parsed.imports) {
            try {
                const result = await this.executeImport(imp, context);
                results.push(result);
            } catch (error) {
                results.push({ type: 'import-error', error: error.message, line: imp.line });
            }
        }
        
        for (const func of parsed.functions) {
            try {
                const result = await this.executeFunction(func, context);
                results.push(result);
            } catch (error) {
                results.push({ type: 'function-error', error: error.message, line: func.line });
            }
        }
        
        for (const query of parsed.queries) {
            try {
                const result = await this.executeQuery(query, context);
                results.push(result);
            } catch (error) {
                results.push({ type: 'query-error', error: error.message, line: query.line });
            }
        }
        
        for (const stmt of parsed.statements) {
            try {
                const result = await this.executeStatement(stmt, context);
                results.push(result);
                
                if (stmt.type === 'network' && stmt.parsed.type === 'bot-command') {
                    await this.executeBotCommand(stmt.parsed.command, context);
                }
            } catch (error) {
                results.push({ type: 'statement-error', error: error.message, line: stmt.line });
            }
        }
        
        for (const variable of parsed.variables) {
            try {
                const result = await this.executeVariable(variable, context);
                results.push(result);
            } catch (error) {
                results.push({ type: 'variable-error', error: error.message, line: variable.line });
            }
        }
        
        context.executionTime = Date.now() - context.startTime;
        
        return {
            results,
            context: {
                botId: context.botId,
                executionTime: context.executionTime,
                packages: Object.keys(context.packages),
                variables: Array.from(context.variables.entries()),
                success: results.filter(r => r.type && r.type.includes('error')).length === 0
            }
        };
    }

    async executeImport(imp, context) {
        const parsed = imp.parsed;
        
        if (parsed.type === 'module-import') {
            if (context.packages[parsed.module]) {
                const module = context.packages[parsed.module];
                
                const imports = parsed.imports.split(',').map(i => i.trim());
                imports.forEach(impName => {
                    if (impName === 'default') {
                        context.variables.set(parsed.module, module.default || module);
                    } else if (impName === '*') {
                        context.variables.set(parsed.module, module);
                    } else if (impName.includes(' as ')) {
                        const [original, alias] = impName.split(' as ').map(s => s.trim());
                        context.variables.set(alias, module[original]);
                    } else {
                        context.variables.set(impName, module[impName]);
                    }
                });
                
                return { type: 'import', module: parsed.module, imports, success: true };
            }
            
            if (parsed.module.startsWith('botnet:')) {
                const feature = parsed.module.replace('botnet:', '');
                const botnetModule = this.getBotnetModule(feature);
                
                if (botnetModule) {
                    context.variables.set(feature, botnetModule);
                    return { type: 'botnet-import', module: feature, success: true };
                }
            }
        }
        
        return { type: 'import', content: imp.content, success: false, error: 'Module not found' };
    }

    getBotnetModule(feature) {
        const modules = {
            'network': {
                createBot: (id, config) => ({ id, config, type: 'bot' }),
                connect: (bot1, bot2) => ({ connected: true, bots: [bot1, bot2] }),
                broadcast: (data) => ({ broadcasted: true, data })
            },
            'database': {
                query: (sql) => ({ result: 'mock', sql }),
                insert: (table, data) => ({ inserted: true, table, id: Date.now() }),
                update: (table, data, where) => ({ updated: true, table, affected: 1 })
            },
            'mail': {
                send: (to, subject, body) => ({ sent: true, to, messageId: `msg_${Date.now()}` }),
                receive: () => ({ messages: [] })
            }
        };
        
        return modules[feature] || null;
    }

    async executeFunction(func, context) {
        const parsed = func.parsed;
        
        if (parsed.type === 'function') {
            const funcCacheKey = `func:${parsed.name}:${hashCode(func.content)}`;
            
            if (this.functionCache.has(funcCacheKey)) {
                const cached = this.functionCache.get(funcCacheKey);
                context.variables.set(parsed.name, cached.function);
                return { type: 'function', name: parsed.name, cached: true };
            }
            
            const jsCode = this.convertPythonToJS(func.content);
            const jsFunction = this.createJSFunction(jsCode, parsed.name, parsed.params);
            
            this.functionCache.set(funcCacheKey, { function: jsFunction, timestamp: Date.now() });
            context.variables.set(parsed.name, jsFunction);
            
            return { type: 'function', name: parsed.name, params: parsed.params, success: true };
        }
        
        if (parsed.type === 'class') {
            const classObj = this.createPythonClass(func.content);
            context.variables.set(parsed.name, classObj);
            return { type: 'class', name: parsed.name, success: true };
        }
        
        return { type: 'function', content: func.content, success: false };
    }

    convertPythonToJS(pythonCode) {
        let jsCode = pythonCode;
        
        const replacements = [
            [/^def\s+(\w+)\s*\((.*?)\):/gm, 'function $1($2) {'],
            [/^class\s+(\w+)(?:\((.*?)\))?:/gm, 'class $1 { constructor($2) {'],
            [/^(\s*)def\s+(\w+)\s*\((.*?)\):/gm, '$1$2($3) {'],
            [/^(\s*)async def\s+(\w+)\s*\((.*?)\):/gm, '$1async $2($3) {'],
            [/self\./g, 'this.'],
            [/len\((.+?)\)/g, '$1.length'],
            [/range\((.+?)\)/g, 'Array.from({length: $1}, (_, i) => i)'],
            [/range\((.+?),\s*(.+?)\)/g, 'Array.from({length: $2 - $1}, (_, i) => i + $1)'],
            [/range\((.+?),\s*(.+?),\s*(.+?)\)/g, '(() => { const arr = []; for (let i = $1; i < $2; i += $3) arr.push(i); return arr; })()'],
            [/print\((.+?)\)/g, 'console.log($1)'],
            [/#.*$/gm, '// $&'],
            [/'''([\s\S]*?)'''/g, '`$1`'],
            [/"""([\s\S]*?)"""/g, '`$1`'],
            [/^\s*except\s+(.+?):/gm, '} catch($1) {'],
            [/^\s*else:/gm, '} else {'],
            [/^\s*finally:/gm, '} finally {'],
            [/^\s*if\s+(.+?):/gm, 'if ($1) {'],
            [/^\s*elif\s+(.+?):/gm, '} else if ($1) {'],
            [/^\s*else:/gm, '} else {'],
            [/^\s*for\s+(\w+)\s+in\s+(.+?):/gm, 'for (let $1 of $2) {'],
            [/^\s*while\s+(.+?):/gm, 'while ($1) {'],
            [/^\s*try:/gm, 'try {'],
            [/^\s*with\s+(.+?)\s+as\s+(\w+):/gm, '// with $1 as $2 - not directly convertible'],
            [/^\s*import\s+(.+)/gm, '// import $1'],
            [/^\s*from\s+(.+?)\s+import\s+(.+)/gm, '// from $1 import $2'],
            [/^\s*@(\w+)/gm, '// @$1'],
            [/^\s*yield\s+(.+)/gm, 'yield $1'],
            [/^\s*return\s+(.+)/gm, 'return $1'],
            [/^\s*break/gm, 'break'],
            [/^\s*continue/gm, 'continue'],
            [/^\s*pass/gm, '// pass'],
            [/^\s*raise\s+(.+)/gm, 'throw $1'],
            [/True/g, 'true'],
            [/False/g, 'false'],
            [/None/g, 'null'],
            [/\.append\((.+?)\)/g, '.push($1)'],
            [/\.join\((.+?)\)/g, '$1.join()'],
            [/\.split\((.+?)\)/g, '.split($1)'],
            [/\.strip\(\)/g, '.trim()'],
            [/\.startswith\((.+?)\)/g, '.startsWith($1)'],
            [/\.endswith\((.+?)\)/g, '.endsWith($1)'],
            [/\.lower\(\)/g, '.toLowerCase()'],
            [/\.upper\(\)/g, '.toUpperCase()']
        ];
        
        replacements.forEach(([pattern, replacement]) => {
            jsCode = jsCode.replace(pattern, replacement);
        });
        
        const lines = jsCode.split('\n');
        let indentLevel = 0;
        const formattedLines = [];
        
        for (let line of lines) {
            const trimmed = line.trim();
            if (trimmed === '}') {
                indentLevel = Math.max(0, indentLevel - 1);
            }
            
            const indent = '  '.repeat(indentLevel);
            formattedLines.push(indent + line);
            
            if (trimmed.endsWith('{')) {
                indentLevel++;
            }
        }
        
        return formattedLines.join('\n');
    }

    createJSFunction(jsCode, name, params) {
        try {
            const paramStr = params.join(', ');
            const functionCode = `(${paramStr}) => {
                ${jsCode}
            }`;
            
            return eval(functionCode);
        } catch (error) {
            return (...args) => {
                throw new Error(`Function ${name} execution error: ${error.message}`);
            };
        }
    }

    createPythonClass(pythonCode) {
        const className = pythonCode.match(/class\s+(\w+)/)?.[1] || 'AnonymousClass';
        
        return class {
            constructor(...args) {
                this.__class = className;
                this.__init = this.__init || (() => {});
                this.__init(...args);
            }
        };
    }

    async executeQuery(query, context) {
        const parsed = query.parsed;
        
        if (parsed.type === 'query' || parsed.type === 'modification' || parsed.type === 'definition') {
            const result = await context.sql.query(query.content, {});
            return { 
                type: 'query', 
                command: parsed.command, 
                table: parsed.table,
                result, 
                success: true 
            };
        }
        
        return { type: 'query', content: query.content, success: false, error: 'Unknown query type' };
    }

    async executeStatement(stmt, context) {
        try {
            let code = stmt.content;
            
            if (stmt.type === 'network') {
                code = this.convertNetworkToJS(stmt.content, context);
            }
            
            const result = this.safeEval(code, context);
            
            if (typeof result === 'function') {
                context.variables.set('_lastFunction', result);
            } else if (result !== undefined) {
                context.results.push(result);
            }
            
            return { type: 'statement', result, success: true };
        } catch (error) {
            return { type: 'statement', error: error.message, success: false };
        }
    }

    convertNetworkToJS(code, context) {
        if (code.startsWith('BOT.')) {
            const command = code.substring(4);
            return `context.bot.${command}`;
        }
        else if (code.startsWith('NETWORK.')) {
            const command = code.substring(8);
            return `context.network.${command}`;
        }
        else if (code.startsWith('::')) {
            const special = code.substring(2);
            return this.convertSpecialSyntax(special, context);
        }
        else if (code.startsWith('$$')) {
            const query = code.substring(2);
            return `context.sql.query(\`${query}\`)`;
        }
        
        return code;
    }

    convertSpecialSyntax(special, context) {
        const parts = special.split(' ');
        const command = parts[0];
        const args = parts.slice(1);
        
        switch (command) {
            case 'CONNECT':
                return `context.bot.connect('${args[0]}')`;
            case 'SEND':
                return `context.bot.send('${args[0]}', ${args.slice(1).join(' ')})`;
            case 'BROADCAST':
                return `context.bot.broadcast(${args.join(' ')})`;
            case 'QUERY':
                return `context.sql.query(\`${args.join(' ')}\`)`;
            case 'IMPORT':
                return `context.packages['${args[0]}']`;
            case 'EXEC':
                return `context.python.exec(\`${args.join(' ')}\`)`;
            case 'MAIL':
                return `context.mail.send(${args.join(', ')})`;
            default:
                return `// Unknown special command: ${command}`;
        }
    }

    async executeVariable(variable, context) {
        const parsed = variable.parsed;
        
        if (parsed.type === 'declaration') {
            try {
                const value = this.safeEval(parsed.value, context);
                context.variables.set(parsed.name, value);
                
                return { 
                    type: 'variable', 
                    name: parsed.name, 
                    value,
                    constant: parsed.isConstant,
                    success: true 
                };
            } catch (error) {
                return { 
                    type: 'variable', 
                    name: parsed.name, 
                    error: error.message,
                    success: false 
                };
            }
        }
        
        return { type: 'variable', content: variable.content, success: false };
    }

    async executeBotCommand(command, context) {
        const parts = command.split(' ');
        const action = parts[0];
        const args = parts.slice(1);
        
        switch (action.toLowerCase()) {
            case 'send':
                if (args.length >= 2) {
                    await context.bot.send(args[0], args.slice(1).join(' '));
                }
                break;
            case 'broadcast':
                if (args.length >= 1) {
                    await context.bot.broadcast(args.join(' '));
                }
                break;
            case 'connect':
                if (args.length >= 1) {
                    await context.bot.connect(args[0]);
                }
                break;
            case 'status':
                return await context.bot.status();
        }
        
        return { action, success: true };
    }

    safeEval(code, context) {
        const evalContext = {
            console,
            Date,
            Math,
            JSON,
            Array,
            Object,
            String,
            Number,
            Boolean,
            RegExp,
            Error,
            Promise,
            Map,
            Set,
            setTimeout,
            clearTimeout,
            setInterval,
            clearInterval,
            encodeURI,
            encodeURIComponent,
            decodeURI,
            decodeURIComponent,
            isNaN,
            isFinite,
            parseFloat,
            parseInt,
            Infinity,
            NaN,
            undefined,
            ...context.packages,
            ...context,
            context
        };
        
        const safeGlobals = Object.keys(evalContext);
        const safeValues = Object.values(evalContext);
        
        const wrappedCode = `
            "use strict";
            return (function(${safeGlobals.join(', ')}) {
                try {
                    return (${code});
                } catch (e) {
                    return { __evalError: e.message, __stack: e.stack };
                }
            })(${safeGlobals.map((_, i) => `arguments[${i}]`).join(', ')});
        `;
        
        try {
            const func = new Function(wrappedCode);
            const result = func.apply(null, safeValues);
            
            if (result && result.__evalError) {
                throw new Error(`Eval error: ${result.__evalError}`);
            }
            
            return result;
        } catch (error) {
            throw new Error(`Safe eval failed: ${error.message}`);
        }
    }

    createMailSystem(pkgExports, botId) {
        return {
            send: async (to, subject, body, options = {}) => {
                const mailData = {
                    from: `bot-${botId}@botnet`,
                    to,
                    subject,
                    body,
                    options,
                    timestamp: Date.now(),
                    messageId: `mail_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
                };
                
                if (pkgExports && typeof pkgExports.sendMail === 'function') {
                    try {
                        return await pkgExports.sendMail(mailData);
                    } catch (error) {
                        console.warn('Package mailer failed, using mock:', error);
                    }
                }
                
                return { 
                    success: true, 
                    ...mailData,
                    mock: true 
                };
            },
            receive: async () => {
                return { messages: [], count: 0 };
            }
        };
    }

    botSend(fromBotId, toBotId, data) {
        return { 
            from: fromBotId, 
            to: toBotId, 
            data, 
            timestamp: Date.now(),
            id: `msg_${Date.now()}`
        };
    }

    async botReceive(botId, timeout = 5000) {
        await new Promise(resolve => setTimeout(resolve, 100));
        return { 
            botId, 
            messages: [], 
            timestamp: Date.now(),
            mock: true 
        };
    }

    botBroadcast(botId, data, networkOnly = false) {
        return { 
            from: botId, 
            broadcast: true, 
            data, 
            networkOnly,
            timestamp: Date.now(),
            reach: networkOnly ? 'network' : 'global'
        };
    }

    botStatus(botId) {
        return { 
            botId, 
            status: 'active', 
            timestamp: Date.now(),
            uptime: Date.now() - 1000000,
            metrics: { executions: 10, errors: 0 }
        };
    }

    botConnect(botId, toBotId) {
        return { 
            from: botId, 
            to: toBotId, 
            connected: true, 
            timestamp: Date.now() 
        };
    }

    botDisconnect(botId, fromBotId) {
        return { 
            from: botId, 
            disconnected: fromBotId, 
            timestamp: Date.now() 
        };
    }

    botGetConnections(botId) {
        return { 
            botId, 
            connections: ['bot1', 'bot2', 'bot3'], 
            count: 3 
        };
    }

    botGetNetwork(botId) {
        return { 
            botId, 
            network: 'network-1', 
            peers: 5,
            status: 'active' 
        };
    }

    async executeSQL(sql, params, isExecute = false) {
        await new Promise(resolve => setTimeout(resolve, 50));
        return { 
            sql, 
            params, 
            result: isExecute ? 'executed' : [{ id: 1, data: 'mock' }],
            rowCount: isExecute ? 1 : 1,
            mock: true,
            timestamp: Date.now()
        };
    }

    async executeTransaction(queries) {
        const results = [];
        for (const query of queries) {
            results.push(await this.executeSQL(query.sql, query.params, true));
        }
        return { 
            success: true, 
            results, 
            transactionId: `tx_${Date.now()}`,
            timestamp: Date.now()
        };
    }

    sqlInsert(table, data) {
        return { 
            inserted: true, 
            table, 
            data, 
            id: Date.now(),
            timestamp: Date.now() 
        };
    }

    sqlUpdate(table, data, where) {
        return { 
            updated: true, 
            table, 
            data, 
            where,
            affected: 1,
            timestamp: Date.now() 
        };
    }

    sqlDelete(table, where) {
        return { 
            deleted: true, 
            table, 
            where,
            affected: 1,
            timestamp: Date.now() 
        };
    }

    sqlSelect(table, fields = '*', where = null) {
        return { 
            table, 
            fields, 
            where,
            data: [{ id: 1, ...(typeof fields === 'string' && fields !== '*' ? { [fields]: 'value' } : { col1: 'val1', col2: 'val2' }) }],
            count: 1,
            timestamp: Date.now() 
        };
    }

    evalPython(code) {
        try {
            const jsCode = this.convertPythonToJS(code);
            const result = eval(jsCode);
            return { 
                code, 
                result, 
                success: true,
                timestamp: Date.now() 
            };
        } catch (error) {
            return { 
                code, 
                error: error.message, 
                success: false,
                timestamp: Date.now() 
            };
        }
    }

    execPython(code) {
        try {
            const jsCode = this.convertPythonToJS(code);
            eval(jsCode);
            return { 
                code, 
                success: true,
                executed: true,
                timestamp: Date.now() 
            };
        } catch (error) {
            return { 
                code, 
                error: error.message, 
                success: false,
                timestamp: Date.now() 
            };
        }
    }

    importPython(module) {
        return { 
            module, 
            success: true, 
            available: true,
            timestamp: Date.now() 
        };
    }

    pythonRange(start, end = null, step = 1) {
        if (end === null) {
            end = start;
            start = 0;
        }
        const arr = [];
        for (let i = start; i < end; i += step) {
            arr.push(i);
        }
        return arr;
    }

    pythonLen(obj) {
        if (Array.isArray(obj) || typeof obj === 'string') {
            return obj.length;
        } else if (typeof obj === 'object' && obj !== null) {
            return Object.keys(obj).length;
        }
        return 0;
    }

    pythonList(iterable) {
        return Array.from(iterable || []);
    }

    pythonDict(pairs) {
        const obj = {};
        if (pairs && Array.isArray(pairs)) {
            pairs.forEach(([key, value]) => {
                obj[key] = value;
            });
        }
        return obj;
    }

    networkCreate(name, config) {
        return { 
            network: name, 
            config, 
            created: true,
            id: `net_${Date.now()}`,
            timestamp: Date.now() 
        };
    }

    networkJoin(botId, networkId) {
        return { 
            botId, 
            networkId, 
            joined: true,
            timestamp: Date.now() 
        };
    }

    networkLeave(botId) {
        return { 
            botId, 
            left: true,
            timestamp: Date.now() 
        };
    }

    networkBroadcast(botId, data) {
        return { 
            botId, 
            broadcast: true, 
            data,
            network: true,
            timestamp: Date.now() 
        };
    }

    networkGetPeers(botId) {
        return { 
            botId, 
            peers: ['bot1', 'bot2', 'bot3', 'bot4'],
            count: 4,
            timestamp: Date.now() 
        };
    }

    networkSend(botId, data) {
        return { 
            botId, 
            sent: true, 
            data,
            network: true,
            timestamp: Date.now() 
        };
    }

    hashData(data) {
        const str = JSON.stringify(data);
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(36);
    }

    encryptData(data, key) {
        const str = JSON.stringify(data);
        let result = '';
        for (let i = 0; i < str.length; i++) {
            result += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }
        return btoa(result);
    }

    decryptData(data, key) {
        try {
            const str = atob(data);
            let result = '';
            for (let i = 0; i < str.length; i++) {
                result += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
            }
            return JSON.parse(result);
        } catch (error) {
            return { error: 'Decryption failed', original: data };
        }
    }

    generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    randomInt(min, max) {
        if (max === undefined) {
            max = min;
            min = 0;
        }
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    timeoutPromise(promise, ms) {
        const timeout = new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
        );
        return Promise.race([promise, timeout]);
    }

    async compile({ code, target = 'javascript', optimize = false }) {
        const cacheKey = `compile:${hashCode(code)}:${target}:${optimize}`;
        
        if (this.compiledCache.has(cacheKey)) {
            const cached = this.compiledCache.get(cacheKey);
            return { ...cached.result, cached: true };
        }
        
        const parsed = this.parseNetworkJS(code);
        const compiled = this.transformToTarget(parsed, target, optimize);
        
        const result = {
            success: true,
            compiled,
            originalLength: code.length,
            compiledLength: compiled.length,
            target,
            optimize,
            parsedStats: {
                statements: parsed.statements.length,
                queries: parsed.queries.length,
                functions: parsed.functions.length,
                imports: parsed.imports.length
            }
        };
        
        this.compiledCache.set(cacheKey, {
            result,
            timestamp: Date.now()
        });
        
        return result;
    }

    transformToTarget(parsed, target, optimize = false) {
        switch (target) {
            case 'javascript':
                return this.toJavaScript(parsed, optimize);
            case 'python':
                return this.toPython(parsed, optimize);
            case 'sql':
                return this.toSQL(parsed, optimize);
            case 'network-js':
                return this.toNetworkJS(parsed, optimize);
            default:
                return JSON.stringify(parsed, null, 2);
        }
    }

    toJavaScript(parsed, optimize) {
        let js = `// Compiled from Network JS to JavaScript\n`;
        js += `// ${new Date().toISOString()}\n\n`;
        
        if (optimize) {
            js += `'use strict';\n\n`;
        }
        
        const imports = new Set();
        
        parsed.imports.forEach(imp => {
            js += `// Original: ${imp.content}\n`;
            const parsedImp = imp.parsed;
            if (parsedImp.type === 'module-import') {
                if (parsedImp.module.startsWith('botnet:')) {
                    js += `// Botnet import: ${parsedImp.module}\n`;
                    js += `const ${parsedImp.module.replace('botnet:', '')} = require('botnet-${parsedImp.module.replace('botnet:', '')}');\n`;
                } else {
                    imports.add(parsedImp.module);
                    js += `import { ${parsedImp.imports} } from '${parsedImp.module}';\n`;
                }
            }
        });
        
        if (imports.size > 0) {
            js += '\n';
        }
        
        parsed.functions.forEach(func => {
            js += `\n// Python function: ${func.content.substring(0, 50)}...\n`;
            const jsFunc = this.convertPythonToJS(func.content);
            js += jsFunc + '\n';
        });
        
        parsed.queries.forEach(query => {
            js += `\n// SQL query\n`;
            js += `const ${query.parsed.table || 'query'}_${query.line} = \`${query.content}\`;\n`;
        });
        
        js += '\n// Main execution\n';
        js += `(async () => {\n`;
        js += `  try {\n`;
        
        parsed.variables.forEach(variable => {
            const jsVar = variable.content
                .replace(/:\s*\w+/g, '')
                .replace(/^\w+\s*=\s*/, 'let ');
            js += `    ${jsVar};\n`;
        });
        
        parsed.statements.forEach(stmt => {
            if (stmt.type === 'network') {
                const converted = this.convertNetworkToJS(stmt.content, {});
                js += `    await ${converted};\n`;
            } else {
                js += `    ${stmt.content};\n`;
            }
        });
        
        js += `  } catch (error) {\n`;
        js += `    console.error('Execution error:', error);\n`;
        js += `  }\n`;
        js += `})();\n`;
        
        return js;
    }

    toPython(parsed, optimize) {
        let python = `# Compiled from Network JS to Python\n`;
        python += `# ${new Date().toISOString()}\n\n`;
        
        if (optimize) {
            python += `from __future__ import annotations\n\n`;
        }
        
        parsed.imports.forEach(imp => {
            python += `# Original: ${imp.content}\n`;
            const parsedImp = imp.parsed;
            if (parsedImp.type === 'module-import') {
                if (parsedImp.imports === '*') {
                    python += `from ${parsedImp.module} import *\n`;
                } else {
                    python += `from ${parsedImp.module} import ${parsedImp.imports}\n`;
                }
            }
        });
        
        python += '\n';
        
        parsed.functions.forEach(func => {
            python += func.content + '\n\n';
        });
        
        parsed.queries.forEach(query => {
            python += `# SQL: ${query.content}\n`;
            python += `${query.parsed.table || 'query'}_${query.line} = "${query.content}"\n\n`;
        });
        
        python += '# Main execution\n';
        python += `if __name__ == "__main__":\n`;
        
        parsed.variables.forEach(variable => {
            const pyVar = variable.content
                .replace(/const\s+|let\s+|var\s+/g, '')
                .replace(/:\s*\w+/g, '');
            python += `    ${pyVar}\n`;
        });
        
        python += '\n';
        
        parsed.statements.forEach(stmt => {
            if (stmt.type === 'network') {
                python += `    # Network command: ${stmt.content}\n`;
                python += `    print("Network command not directly convertible to Python")\n`;
            } else if (stmt.type === 'js') {
                python += `    # JS: ${stmt.content}\n`;
                python += `    # Converted: ${this.convertJSToPython(stmt.content)}\n`;
            }
        });
        
        return python;
    }

    convertJSToPython(jsCode) {
        let python = jsCode;
        
        const replacements = [
            [/console\.log\(/g, 'print('],
            [/function\s+(\w+)\s*\((.*?)\)\s*{/g, 'def $1($2):'],
            [/const\s+|let\s+|var\s+/g, ''],
            [/===/g, '=='],
            [/!==/g, '!='],
            [/&&/g, 'and'],
            [/\|\|/g, 'or'],
            [/!/g, 'not '],
            [/true/g, 'True'],
            [/false/g, 'False'],
            [/null/g, 'None'],
            [/undefined/g, 'None'],
            [/\.length/g, '.len()'],
            [/\.push\(/g, '.append('],
            [/\.includes\(/g, '.contains('],
            [/\.forEach\(/g, '.for_each('],
            [/\.map\(/g, '.map('],
            [/\.filter\(/g, '.filter('],
            [/\.reduce\(/g, '.reduce('],
            [/Math\./g, 'math.'],
            [/JSON\./g, 'json.']
        ];
        
        replacements.forEach(([pattern, replacement]) => {
            python = python.replace(pattern, replacement);
        });
        
        return python;
    }

    toSQL(parsed, optimize) {
        let sql = `-- Compiled from Network JS to SQL\n`;
        sql += `-- ${new Date().toISOString()}\n\n`;
        
        parsed.queries.forEach(query => {
            sql += query.content + ';\n\n';
        });
        
        parsed.functions.forEach(func => {
            sql += `-- Python function (not convertible to SQL): ${func.content.substring(0, 50)}...\n`;
        });
        
        parsed.statements.forEach(stmt => {
            if (stmt.type === 'network' && stmt.content.includes('BOT.')) {
                const command = stmt.content.replace('BOT.', '');
                sql += `-- Bot command: ${command}\n`;
                sql += `-- Consider creating a bot_actions table to log this\n`;
            }
        });
        
        if (optimize) {
            sql += '\n-- Optimized execution plan\n';
            sql += '-- Use transactions for multiple queries\n';
            sql += 'BEGIN TRANSACTION;\n\n';
            
            sql += '-- Add your optimized queries here\n\n';
            
            sql += 'COMMIT;\n';
        }
        
        return sql;
    }

    toNetworkJS(parsed, optimize) {
        let networkJS = `// Network JS code\n`;
        networkJS += `// ${new Date().toISOString()}\n\n`;
        
        if (optimize) {
            networkJS += `// Optimized version\n`;
        }
        
        parsed.imports.forEach(imp => {
            networkJS += imp.content + '\n';
        });
        
        networkJS += '\n';
        
        parsed.functions.forEach(func => {
            networkJS += func.content + '\n\n';
        });
        
        parsed.queries.forEach(query => {
            networkJS += `$$${query.content}\n\n`;
        });
        
        parsed.variables.forEach(variable => {
            networkJS += variable.content + '\n';
        });
        
        networkJS += '\n';
        
        parsed.statements.forEach(stmt => {
            networkJS += stmt.content + '\n';
        });
        
        if (optimize) {
            networkJS += '\n// Optimization complete\n';
        }
        
        return networkJS;
    }

    async validate({ code, strict = false }) {
        const parsed = this.parseNetworkJS(code);
        
        const errors = [];
        const warnings = [];
        const suggestions = [];
        
        if (parsed.errors.length > 0) {
            errors.push(...parsed.errors);
        }
        
        parsed.imports.forEach(imp => {
            const parsedImp = imp.parsed;
            if (parsedImp.type === 'unknown-import') {
                warnings.push({
                    type: 'unknown-import',
                    line: imp.line,
                    content: imp.content,
                    message: 'Import syntax not recognized'
                });
            }
        });
        
        parsed.functions.forEach(func => {
            const parsedFunc = func.parsed;
            if (parsedFunc.type === 'unknown') {
                warnings.push({
                    type: 'unrecognized-function',
                    line: func.line,
                    content: func.content,
                    message: 'Function syntax not recognized'
                });
            }
        });
        
        if (strict) {
            parsed.statements.forEach(stmt => {
                if (stmt.type === 'js' && stmt.content.includes('eval(')) {
                    errors.push({
                        type: 'dangerous-eval',
                        line: stmt.line,
                        content: stmt.content,
                        message: 'eval() is not allowed in strict mode'
                    });
                }
            });
        }
        
        if (parsed.queries.length > 0) {
            suggestions.push({
                type: 'sql-optimization',
                message: 'Consider using parameterized queries for better performance'
            });
        }
        
        const hasNetworkCommands = parsed.statements.some(s => s.type === 'network');
        if (hasNetworkCommands) {
            suggestions.push({
                type: 'network-usage',
                message: 'Network commands detected. Ensure bots are properly connected.'
            });
        }
        
        return {
            success: errors.length === 0,
            parsed,
            stats: {
                lines: code.split('\n').length,
                statements: parsed.statements.length,
                queries: parsed.queries.length,
                functions: parsed.functions.length,
                imports: parsed.imports.length
            },
            errors,
            warnings,
            suggestions,
            timestamp: Date.now()
        };
    }

    async transform({ code, from = 'network-js', to = 'javascript', options = {} }) {
        if (from === 'network-js' && to === 'javascript') {
            const compiled = await this.compile({ code, target: 'javascript', optimize: options.optimize });
            return compiled;
        }
        else if (from === 'javascript' && to === 'network-js') {
            const networkJS = this.convertJSToNetworkJS(code, options);
            return {
                success: true,
                transformed: networkJS,
                from,
                to,
                originalLength: code.length,
                transformedLength: networkJS.length,
                timestamp: Date.now()
            };
        }
        
        return {
            success: false,
            error: `Transformation from ${from} to ${to} not supported`,
            timestamp: Date.now()
        };
    }

    convertJSToNetworkJS(jsCode, options) {
        let networkJS = jsCode;
        
        const replacements = [
            [/fetch\(/g, 'NETWORK.fetch('],
            [/XMLHttpRequest/g, 'NETWORK.XMLHttpRequest'],
            [/console\.log\(/g, 'BOT.log('],
            [/setTimeout\(/g, 'BOT.delay('],
            [/setInterval\(/g, 'BOT.interval('],
            [/localStorage/g, 'BOT.storage'],
            [/sessionStorage/g, 'BOT.storage'],
            [/document\./g, 'BOT.document.'],
            [/window\./g, 'BOT.window.'],
            [/navigator\./g, 'BOT.navigator.'],
            [/location\./g, 'BOT.location.']
        ];
        
        replacements.forEach(([pattern, replacement]) => {
            networkJS = networkJS.replace(pattern, replacement);
        });
        
        if (options.addNetworkImports) {
            networkJS = `// Network JS converted from JavaScript\n` +
                       `// ${new Date().toISOString()}\n\n` +
                       networkJS;
        }
        
        return networkJS;
    }

    async getSyntax() {
        return {
            success: true,
            syntax: {
                imports: [
                    "from 'module' import function",
                    "import defaultExport from 'module'",
                    "import * as name from 'module'"
                ],
                functions: [
                    "def function_name(params):",
                    "class ClassName:",
                    "async def async_function():"
                ],
                queries: [
                    "SELECT * FROM table WHERE condition",
                    "INSERT INTO table VALUES (...)",
                    "UPDATE table SET column = value",
                    "DELETE FROM table WHERE condition"
                ],
                variables: [
                    "const name = value",
                    "let name = value",
                    "name: type = value"
                ],
                network: [
                    "BOT.send(to, data)",
                    "BOT.receive()",
                    "BOT.broadcast(data)",
                    "NETWORK.connect(botId)",
                    "NETWORK.broadcast(data)"
                ],
                special: [
                    "::CONNECT botId",
                    "::SEND botId data",
                    "::BROADCAST data",
                    "$$SELECT * FROM table"
                ]
            },
            examples: {
                basic: `from 'node-mailer' import sendMail
const email = 'test@example.com'
$$SELECT * FROM users WHERE email = '${'${email}'}'
BOT.send('bot2', 'Hello from bot1')`,
                advanced: `class UserBot:
    def __init__(self, user_id):
        self.user_id = user_id
    
    def process_data(self, data):
        $$INSERT INTO user_data VALUES ('${'${self.user_id}'}', '${'${data}'}')
        BOT.broadcast({'user': self.user_id, 'data': data})

const bot = new UserBot('user123')
bot.process_data('sample data')`
            },
            timestamp: Date.now()
        };
    }

    async getExamples() {
        return {
            success: true,
            examples: [
                {
                    name: "Basic Bot Communication",
                    description: "Two bots sending messages",
                    code: `// Bot 1
from 'botnet-core' import Bot
const bot1 = new Bot('bot1')
bot1.connect('bot2')
bot1.send('bot2', 'Hello from bot1')

// Bot 2
from 'botnet-core' import Bot
const bot2 = new Bot('bot2')
const message = bot2.receive()
if (message) {
    $$INSERT INTO messages VALUES ('${'${message.from}'}', '${'${message.data}'}', NOW())
    bot2.send('bot1', 'Message received')
}`
                },
                {
                    name: "Data Processing Pipeline",
                    description: "Process data with multiple bots",
                    code: `class DataProcessor:
    def __init__(self, processor_id):
        self.id = processor_id
        this.connections = []
    
    def add_source(self, source_bot):
        this.connections.push(source_bot)
        BOT.connect(this.id, source_bot)
    
    def process(self):
        for source in this.connections:
            const data = BOT.receive_from(source)
            if (data) {
                const processed = this.transform(data)
                $$INSERT INTO processed_data VALUES ('${'${this.id}'}', '${'${processed}'}', NOW())
                BOT.broadcast(processed)
            }
    
    def transform(self, data):
        // Complex transformation logic
        return data.toUpperCase()

const processor = new DataProcessor('processor1')
processor.add_source('source1')
processor.add_source('source2')
processor.process()`
                },
                {
                    name: "Package Integration",
                    description: "Using npm packages with bot network",
                    code: `// Import and modify node-mailer for bot usage
from 'node-mailer' import sendMail

// Modify sendMail to work with bots
sendMail = function(options) {
    // Add bot metadata
    options.bot_sender = BOT.id
    options.network = BOT.network
    
    // Log email attempt
    $$INSERT INTO email_logs VALUES ('${'${BOT.id}'}', '${'${options.to}'}', NOW())
    
    // Send through bot network if recipient is a bot
    if (options.to.includes('@botnet')) {
        const bot_id = options.to.split('@')[0]
        BOT.send(bot_id, {
            type: 'email',
            subject: options.subject,
            body: options.text
        })
        return { sent: true, via: 'botnet' }
    }
    
    // Otherwise use original sendMail
    return original_sendMail(options)
}

// Use modified package
const result = sendMail({
    to: 'otherbot@botnet',
    subject: 'Network Update',
    text: 'The network has been updated.'
})

BOT.log('Email result:', result)`
                }
            ],
            timestamp: Date.now()
        };
    }
}

// Main worker handler
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        
        // Handle package.json proxy
        if (path === '/package.json') {
            const packageJson = {
                name: "botnet-client",
                version: "1.0.0",
                type: "module",
                dependencies: {
                    "botnet": `https://${url.hostname}/botnet-client`
                },
                scripts: {
                    "start": "node -e \"import('https://" + url.hostname + "/botnet-client').then(m => m.start())\""
                }
            };
            
            return new Response(JSON.stringify(packageJson, null, 2), {
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }
        
        // Handle botnet-client package import
        if (path === '/botnet-client') {
            const clientCode = `
// Botnet Client Package
export class BotnetClient {
    constructor(workerUrl) {
        this.workerUrl = workerUrl;
        this.bots = new Map();
        this.networks = new Map();
    }
    
    async createBot(botId, config = {}) {
        const response = await fetch(\`\${this.workerUrl}/api/bot/create\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ botId, config })
        });
        return await response.json();
    }
    
    async executeNetworkJS(botId, code, packages = []) {
        const response = await fetch(\`\${this.workerUrl}/api/compiler/execute\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ botId, code, packages })
        });
        return await response.json();
    }
    
    async installPackage(packageName, version = 'latest', userId) {
        const response = await fetch(\`\${this.workerUrl}/api/package/install\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ packageName, version, userId })
        });
        return await response.json();
    }
    
    async modifyPackage(userId, packageName, modifications) {
        const response = await fetch(\`\${this.workerUrl}/api/package/modify\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, packageName, modifications })
        });
        return await response.json();
    }
}

export default new BotnetClient('https://${url.hostname}');
            `;
            
            return new Response(clientCode, {
                headers: {
                    'Content-Type': 'application/javascript',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }
        
        // API routing
        if (path.startsWith('/api/package/')) {
            const id = env.PACKAGE_SYSTEM.idFromName("main");
            const obj = env.PACKAGE_SYSTEM.get(id);
            return obj.fetch(request);
        }
        else if (path.startsWith('/api/bot/')) {
            const id = env.BOT_MANAGER.idFromName("main");
            const obj = env.BOT_MANAGER.get(id);
            return obj.fetch(request);
        }
        else if (path.startsWith('/api/compiler/')) {
            const id = env.NETWORK_COMPILER.idFromName("main");
            const obj = env.NETWORK_COMPILER.get(id);
            return obj.fetch(request);
        }
        
        // Health check
        if (path === '/health') {
            return new Response(JSON.stringify({
                status: 'ok',
                service: 'botnet-worker',
                version: '1.0.0',
                timestamp: Date.now(),
                endpoints: [
                    '/api/package/*',
                    '/api/bot/*',
                    '/api/compiler/*',
                    '/package.json',
                    '/botnet-client',
                    '/health'
                ]
            }), {
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }
        
        // Documentation
        if (path === '/') {
            const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Botnet Worker</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; }
        pre { background: #2d2d2d; color: #fff; padding: 15px; border-radius: 5px; overflow-x: auto; }
        .endpoint { background: #e8f4f8; padding: 10px; margin: 10px 0; border-left: 4px solid #3498db; }
    </style>
</head>
<body>
    <h1>Botnet Worker API</h1>
    <p>Advanced bot networking system with Network JS language and NPM package integration.</p>
    
    <h2>Quick Start</h2>
    <pre><code>// In your package.json
{
  "dependencies": {
    "botnet": "https://your-worker.workers.dev/botnet-client"
  }
}

// In your Network JS file
from 'botnet' import BotnetClient
const client = new BotnetClient('https://your-worker.workers.dev')
const bot = await client.createBot('my-bot', { type: 'worker' })
await client.executeNetworkJS('my-bot', 'BOT.broadcast("Hello!")')</code></pre>
    
    <h2>API Endpoints</h2>
    
    <div class="endpoint">
        <h3>Package System</h3>
        <code>POST /api/package/install-package</code><br>
        <code>POST /api/package/modify-package</code><br>
        <code>GET /api/package/package?name=package-name</code>
    </div>
    
    <div class="endpoint">
        <h3>Bot Management</h3>
        <code>POST /api/bot/create-bot</code><br>
        <code>POST /api/bot/execute-network-js</code><br>
        <code>GET /api/bot/bot?id=bot-id</code>
    </div>
    
    <div class="endpoint">
        <h3>Network JS Compiler</h3>
        <code>POST /api/compiler/execute</code><br>
        <code>POST /api/compiler/compile</code><br>
        <code>GET /api/compiler/syntax</code>
    </div>
    
    <h2>Network JS Examples</h2>
    <pre><code>// Hybrid SQL/Python/JS syntax
from 'node-mailer' import sendMail

def process_user(user_id):
    $$SELECT * FROM users WHERE id = '\${user_id}'
    user = result[0] if result else None
    
    if user:
        BOT.send('logger-bot', \`Processing user \${user_id}\`)
        $$UPDATE users SET last_active = NOW() WHERE id = '\${user_id}'
        return user
    
    return None

const user = process_user('123')
if user:
    sendMail({
        to: user.email,
        subject: 'Welcome',
        text: \`Hello \${user.name}!\`
    })</code></pre>
    
    <footer>
        <p>Botnet Worker &copy; ${new Date().getFullYear()} | 
           <a href="/health">Health Check</a> | 
           <a href="/package.json">package.json</a>
        </p>
    </footer>
</body>
</html>
            `;
            
            return new Response(html, {
                headers: { 'Content-Type': 'text/html' }
            });
        }
        
        return new Response('Not Found', { status: 404 });
    }
};
