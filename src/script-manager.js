const fs = require('fs/promises');
const path = require('path');
const { constants: fsConstants } = require('fs');

const SCRIPTS_JSON_NAME = 'scripts.json';

class ScriptManager {
    constructor(scriptsDir) {
        this.scriptsDir = scriptsDir;
        this.scriptsJsonPath = path.join(scriptsDir, SCRIPTS_JSON_NAME);
    }

    async _readScriptsJson() {
        try {
            const content = await fs.readFile(this.scriptsJsonPath, 'utf8');
            return JSON.parse(content);
        } catch (err) {
            if (err.code === 'ENOENT') {
                return { scripts: {} };
            }
            // If JSON is corrupted, return empty/safe default but maybe log warning?
            // For now, let's treat it as empty but log error in console if needed.
            console.warn('Error reading scripts.json:', err);
            return { scripts: {} };
        }
    }

    async _writeScriptsJson(data) {
        await fs.writeFile(
            this.scriptsJsonPath,
            JSON.stringify(data, null, 2),
            'utf8'
        );
    }

    /**
     * Scans the scripts directory and merges with metadata from scripts.json
     * Returns an array of objects: { name, description, ... }
     */
    async listScripts() {
        const metadata = await this._readScriptsJson();
        const knownScripts = metadata.scripts || {};

        let entries;
        try {
            entries = await fs.readdir(this.scriptsDir, { withFileTypes: true });
        } catch (err) {
            if (err.code === 'ENOENT') return [];
            throw err;
        }

        const results = [];

        for (const entry of entries) {
            if (!entry.isFile()) continue;
            if (entry.name === SCRIPTS_JSON_NAME) continue;
            if (entry.name.startsWith('.')) continue; // Ignore dotfiles

            const name = entry.name;
            const meta = knownScripts[name] || {};

            try {
                // Check if executable
                await fs.access(path.join(this.scriptsDir, name), fsConstants.X_OK);

                results.push({
                    name,
                    description: meta.description || null,
                    args: meta.args || [],
                });
            } catch (err) {
                // Not executable, skip
                continue;
            }
        }

        return results;
    }

    async getScriptContent(name) {
        const scriptPath = path.join(this.scriptsDir, name);
        return await fs.readFile(scriptPath, 'utf8');
    }

    async updateScriptMetadata(name, updates) {
        const data = await this._readScriptsJson();
        if (!data.scripts) data.scripts = {};

        data.scripts[name] = {
            ...data.scripts[name],
            ...updates
        };

        await this._writeScriptsJson(data);
    }
}

module.exports = {
    ScriptManager
};
