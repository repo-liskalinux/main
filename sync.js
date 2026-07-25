const fs = require('fs');
const path = require('path');
const ARCH_MIRROR = "http://mirror.rackspace.com/archlinux";
const REPOS = ["core", "extra"];
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

async function fetchArchPackages(repo) {
    let packages = [];
    for (const arch of ARCHS) {
        const url = `${ARCH_MIRROR}/${repo}/os/${arch}/`;
        console.log(`Scanning mirror: ${url}`);
        try {
            const response = await fetch(url);
            if (!response.ok) continue;
            const html = await response.text();
            const regex = /href="([^"]+\.pkg\.tar\.zst)"/g;
            let match;
            while ((match = regex.exec(html)) !== null) {
                const filename = match[1];
                const partsMatch = filename.match(/^(.*?)-([^-]+-[^-]+)-([^-]+)\.pkg\.tar\.zst$/);
                if (partsMatch) {
                    const [, name, version] = partsMatch;
                    packages.push({
                        name: name,
                        version: version,
                        url: `${url}${filename}`
                    });
                }
            }
        } catch (error) {
            console.error(`Failed to get data from ${url}:`, error.message);
        }
    }
    return packages;
}

async function main() {
    const blacklist = loadBlacklist();
    for (const repo of REPOS) {
        console.log(`\nProcessing repository: ${repo}`);
        const repoDir = path.join(__dirname, 'x86_64', repo);
        if (!fs.existsSync(repoDir)) {
            fs.mkdirSync(repoDir, { recursive: true });
        }
        const dbPath = path.join(repoDir, 'db.json');
        let existingPackages = [];
        if (fs.existsSync(dbPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
                if (data.packages) existingPackages = data.packages;
            } catch (e) {
                console.log(`Failed to read old db.json on ${repo}, creating new db.json....`);
            }
        }
        const liskaPackages = existingPackages.filter(pkg => pkg.url.includes("archive.org"));
        const liskaMap = new Map(liskaPackages.map(pkg => [pkg.name, pkg]));
        const archPkgs = await fetchArchPackages(repo);
        const updatedArchMap = new Map();
        for (const pkg of archPkgs) {
            if (blacklist.has(pkg.name) || pkg.name.toLowerCase().includes("arch") || pkg.name.toLowerCase().includes("archlinux")) {
                continue;
            }
            if (liskaMap.has(pkg.name)) continue;
            updatedArchMap.set(pkg.name, {
                name: pkg.name,
                version: pkg.version,
                url: pkg.url
            });
        }
        const finalPackages = [
            ...Array.from(liskaMap.values()),
            ...Array.from(updatedArchMap.values())
        ];
        finalPackages.sort((a, b) => a.name.localeCompare(b.name));
        const outputData = { packages: finalPackages };
        fs.writeFileSync(dbPath, JSON.stringify(outputData, null, 2), 'utf8');
        console.log(`Successfully updating ${dbPath} (${finalPackages.length} total packages).`);
    }
}
main();
