const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ARCH_MIRROR = "https://ftp.sh.cvut.cz/artix-linux/";
const REPOS = ["system", "world", "galaxy", "lib32"];
const ARCHS = ["x86_64"];

function loadBlacklist() {
    const blacklist = new Set();
    const blacklistPath = path.join(__dirname, 'blacklist.txt');
    if (fs.existsSync(blacklistPath)) {
        const lines = fs.readFileSync(blacklistPath, 'utf8').split('\n');
        for (let line of lines) {
            line = line.trim();
            if (line && !line.startsWith('#')) {
                blacklist.add(line);
            }
        }
    }
    return blacklist;
}

function parseArchDbSectionFile(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const sections = {};
    let currentSection = null;
    for (let rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const headerMatch = line.match(/^%([A-Z0-9_]+)%$/);
        if (headerMatch) {
            currentSection = headerMatch[1];
            sections[currentSection] = [];
        } else if (currentSection) {
            sections[currentSection].push(line);
        }
    }
    return sections;
}

function parseInfoFile(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    const result = { provides: [], depends: [], optdepends: [], conflicts: [] };
    content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) return;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        switch (key) {
            case 'pkgname': result.name = value; break;
            case 'pkgver': result.version = value; break;
            case 'depend':
            case 'depends': result.depends.push(value); break;
            case 'optdepend':
            case 'optdepends': result.optdepends.push(value); break;
            case 'provide':
            case 'provides': result.provides.push(value); break;
            case 'conflict':
            case 'conflicts': result.conflicts.push(value); break;
        }
    });
    return result;
}

function calculateSHA256(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

function toArray(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') return [val];
    return [];
}

function normalizePackage(pkg, defaultOrigin = null) {
    return {
        name: pkg.name || "unknown",
        version: pkg.version || "0.1.0",
        origin: pkg.origin || defaultOrigin,
        sha256: pkg.sha256 || null,
        url: pkg.url || "",
        provides: Array.from(new Set(toArray(pkg.provides))),
        depends: Array.from(new Set(toArray(pkg.depends))),
        optdepends: Array.from(new Set(toArray(pkg.optdepends))),
        conflicts: Array.from(new Set(toArray(pkg.conflicts)))
    };
}

async function fetchAndParseArchDb(repo) {
    const repoUrl = `${ARCH_MIRROR}/${repo}/os/x86_64`;
    const dbUrl = `${repoUrl}/${repo}.db`;
    const tmpDir = path.join('/tmp', `db-${repo}-${Date.now()}`);
    const dbTarPath = path.join(tmpDir, `${repo}.db`);
    fs.mkdirSync(tmpDir, { recursive: true });
    console.log(`[+] Downloading database: ${dbUrl}`);
    try {
        const res = await fetch(dbUrl);
        if (!res.ok) {
            console.error(`[-] Failed to download database: ${dbUrl}`);
            return [];
        }
        const arrayBuffer = await res.arrayBuffer();
        fs.writeFileSync(dbTarPath, Buffer.from(arrayBuffer));
        const extractDir = path.join(tmpDir, 'extracted');
        fs.mkdirSync(extractDir, { recursive: true });
        execSync(`tar -xf "${dbTarPath}" -C "${extractDir}"`);
        const packages = [];
        const folders = fs.readdirSync(extractDir);
        for (const folder of folders) {
            const pkgDirPath = path.join(extractDir, folder);
            if (!fs.statSync(pkgDirPath).isDirectory()) continue;
            const descData = parseArchDbSectionFile(path.join(pkgDirPath, 'desc'));
            const dependsData = parseArchDbSectionFile(path.join(pkgDirPath, 'depends'));
            const pkgData = { ...descData, ...dependsData };
            const name = pkgData['NAME']?.[0];
            if (!name) continue;
            const version = pkgData['VERSION']?.[0] || "";
            const filename = pkgData['FILENAME']?.[0] || "";
            const sha256 = pkgData['SHA256SUM']?.[0] || null;
            packages.push(normalizePackage({
                name: name,
                version: version,
                origin: `artix-${repo}`,
                sha256: sha256,
                url: filename ? `${repoUrl}/${filename}` : "",
                provides: pkgData['PROVIDES'] || [],
                depends: pkgData['DEPENDS'] || [],
                optdepends: pkgData['OPTDEPENDS'] || [],
                conflicts: pkgData['CONFLICTS'] || []
            }));
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return packages;
    } catch (error) {
        console.error(`[-] Error when processing database ${repo}:`, error.message);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return [];
    }
}

async function main() {
    const rootDir = process.cwd();
    const blacklist = loadBlacklist();
    console.log("::: [ LKPM Repository Sync and Builder ] :::\n");
    const liskaMap = new Map();
    const lskPkgPath = path.join(rootDir, 'lsk-pkg.json');
    if (fs.existsSync(lskPkgPath)) {
        try {
            const rawLsk = JSON.parse(fs.readFileSync(lskPkgPath, 'utf8'));
            const pkgList = Array.isArray(rawLsk) ? rawLsk : (rawLsk.packages || []);
            pkgList.forEach(pkg => {
                const normalized = normalizePackage(pkg, "liska");
                liskaMap.set(normalized.name, normalized);
            });
            console.log(`[+] Loading ${liskaMap.size} package from lsk-pkg.json`);
        } catch (e) {
            console.warn("[-] WARNING: Failed to parse lsk-pkg.json");
        }
    }
    const pkgInfo = parseInfoFile(path.join(rootDir, '.PKGINFO'));
    const buildInfo = parseInfoFile(path.join(rootDir, '.BUILDINFO'));
    if (pkgInfo.name || buildInfo.name) {
        let pkgSha256 = null;
        const builtFiles = fs.readdirSync(rootDir).filter(f => f.endsWith('.lsk') || f.endsWith('.pkg.tar.zst'));
        if (builtFiles.length > 0) {
            pkgSha256 = calculateSHA256(path.join(rootDir, builtFiles[0]));
        }
        const localPkg = normalizePackage({
            name: pkgInfo.name || buildInfo.name,
            version: pkgInfo.version || buildInfo.version,
            origin: pkgInfo.origin || buildInfo.origin || "liska-local",
            sha256: pkgSha256,
            url: pkgInfo.url || buildInfo.url || "",
            provides: [...(pkgInfo.provides || []), ...(buildInfo.provides || [])],
            depends: [...(pkgInfo.depends || []), ...(buildInfo.depends || [])],
            optdepends: [...(pkgInfo.optdepends || []), ...(buildInfo.optdepends || [])],
            conflicts: [...(pkgInfo.conflicts || []), ...(buildInfo.conflicts || [])]
        });
        liskaMap.set(localPkg.name, localPkg);
        console.log(`[+] Intregated local build: ${localPkg.name}`);
    }
    for (const repo of REPOS) {
        console.log(`-------------------------------`);
        console.log(`::: [ Repository: ${repo} ] :::`);
        console.log(`-------------------------------`);
        const repoDir = path.join(rootDir, 'x86_64', repo);
        if (!fs.existsSync(repoDir)) {
            fs.mkdirSync(repoDir, { recursive: true });
        }
        const dbJsonPath = path.join(repoDir, 'db.json');
        const dbTarZstPath = path.join(repoDir, 'db.json.tar.zst');
        const archPkgs = await fetchAndParseArchDb(repo);
        const updatedArchMap = new Map();
        for (const pkg of archPkgs) {
            const lowerName = pkg.name.toLowerCase();
            if (blacklist.has(pkg.name) ||
                lowerName.startsWith('artix-') ||
                lowerName.startsWith('artixnews') ||
                lowerName.startsWith('archlinux-') ||
                lowerName.startsWith('mkinitcpio-') ||
                lowerName.endsWith('-doc') ||
                lowerName.endsWith('-docs')) {
                continue;
            }
            if (repo === "system" && liskaMap.has(pkg.name)) continue;
            updatedArchMap.set(pkg.name, pkg);
        }
        const repoLiskaPackages = (repo === "system") ? Array.from(liskaMap.values()) : [];
        const finalPackages = [
            ...repoLiskaPackages,
            ...Array.from(updatedArchMap.values())
        ];
        finalPackages.sort((a, b) => a.name.localeCompare(b.name));
        fs.writeFileSync(dbJsonPath, JSON.stringify(finalPackages, null, 2), 'utf8');
        console.log(`[✓] Output: ${dbJsonPath} (${finalPackages.length} package)`);
        try {
            execSync(`tar -I 'zstd' -cf "${dbTarZstPath}" -C "${repoDir}" db.json`);
            console.log(`[✓] Output lkpm: ${dbTarZstPath}`);
        } catch (err) {
            console.error(`[✗] Failed to compress zstd:`, err.message);
        }
    }
    console.log("::: [ FINISHED ] Database has been updated successfully!");
}
main();
