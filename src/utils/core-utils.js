import jsyaml from 'js-yaml';

export function parseYAML(yamlStr) {
    try {
        return jsyaml.load(yamlStr);
    } catch (e) {
        throw new Error(`YAML inválido: ${e.message}`);
    }
}

export function fixYAML(yamlStr) {
    return yamlStr
        .replace(/\t/g, '  ')
        .split('\n')
        .map((line) => {
            if (line.trim() && !line.includes(':') && line.match(/^\s*\w+\s+\w+/)) {
                const match = line.match(/^(\s*)(\w+)\s+(.+)$/);
                if (match) {
                    return `${match[1]}${match[2]}: ${match[3]}`;
                }
            }
            return line;
        })
        .join('\n')
        .replace(/[^\x20-\x7E\n\r\t]/g, '')
        .replace(/\n{3,}/g, '\n\n');
}

export function validateJSON(str) {
    try {
        JSON.parse(str);
        return { valid: true, error: null };
    } catch (e) {
        return { valid: false, error: e.message };
    }
}

export function validateYAML(str) {
    try {
        jsyaml.load(str);
        return { valid: true, error: null };
    } catch (e) {
        return { valid: false, error: e.message };
    }
}

export function sanitizeFilename(name) {
    return name.replace(/[^a-z0-9_.]/gi, '_').toLowerCase();
}

export function pruneEmptyFields(obj) {
    if (obj === null || obj === undefined) return undefined;
    if (typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
        const nextArray = obj
            .map(pruneEmptyFields)
            .filter((v) => v !== undefined && v !== null && (typeof v !== 'object' || Object.keys(v).length > 0));
        return nextArray.length > 0 ? nextArray : undefined;
    }

    const nextObj = {};
    for (const key in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
        const value = pruneEmptyFields(obj[key]);
        if (value === undefined || value === null || value === '') continue;
        if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
        nextObj[key] = value;
    }

    return Object.keys(nextObj).length > 0 ? nextObj : undefined;
}

export function buildTimestampToken(date = new Date()) {
    const pad = (n, size = 2) => String(n).padStart(size, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        '_',
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
        '_',
        pad(date.getMilliseconds(), 3)
    ].join('');
}

export function looksLikeMojibake(value) {
    if (!value || typeof value !== 'string') return false;
    return /Ã.|Â.|â[\u0080-\u00BF]|�/.test(value);
}

export function repairMojibake(value) {
    if (value === null || value === undefined) return value;
    let text = String(value);
    if (!looksLikeMojibake(text)) return text;

    for (let i = 0; i < 2; i++) {
        try {
            const bytes = new Uint8Array(text.length);
            for (let j = 0; j < text.length; j++) {
                bytes[j] = text.charCodeAt(j) & 0xff;
            }
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (!decoded || decoded === text) break;
            text = decoded;
        } catch {
            break;
        }
        if (!looksLikeMojibake(text)) break;
    }

    return text;
}

export function convertXmlValue(value, schemaOrType) {
    if (value === null || value === undefined) return value;

    const normalizedValue = repairMojibake(value);
    const schemaType = typeof schemaOrType === 'string' ? schemaOrType : schemaOrType?.type;

    switch (schemaType) {
        case 'number':
        case 'integer': {
            const numeric = Number(normalizedValue);
            return Number.isNaN(numeric) ? normalizedValue : numeric;
        }
        case 'boolean': {
            const str = String(normalizedValue).toLowerCase();
            if (str === 'true') return true;
            if (str === 'false') return false;
            return Boolean(normalizedValue);
        }
        case 'string':
        default:
            return String(normalizedValue);
    }
}
