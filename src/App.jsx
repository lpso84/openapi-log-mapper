import React, { useState, useEffect, useRef } from 'react';
import jsyaml from 'js-yaml';
import hljs from 'highlight.js/lib/core';
import 'highlight.js/styles/atom-one-dark.css';
import xml from 'highlight.js/lib/languages/xml';
import json from 'highlight.js/lib/languages/json';
import curl from 'highlight.js/lib/languages/bash';

hljs.registerLanguage('xml', xml);
hljs.registerLanguage('json', json);
hljs.registerLanguage('curl', curl);

// YAML Parser simples
function parseYAML(yamlStr) {
    try {
        return jsyaml.load(yamlStr);
    } catch (e) {
        throw new Error(`YAML inválido: ${e.message}`);
    }
}

function fixYAML(yamlStr) {
    let fixed = yamlStr
        .replace(/\t/g, '  ') // tabs para espaços
        .split('\n')
        .map(line => {
            // Corrigir linhas do tipo "key value" para "key: value"
            if (line.trim() && !line.includes(':') && line.match(/^\s*\w+\s+\w+/)) {
                const match = line.match(/^(\s*)(\w+)\s+(.+)$/);
                if (match) {
                    return `${match[1]}${match[2]}: ${match[3]}`;
                }
            }
            return line;
        })
        .join('\n')
        .replace(/[^\x20-\x7E\n\r\t]/g, '') // remove caracteres inválidos
        .replace(/\n{3,}/g, '\n\n'); // remove excesso de linhas vazias
    return fixed;
}

function validateJSON(str) {
    try {
        JSON.parse(str);
        return { valid: true, error: null };
    } catch (e) {
        return { valid: false, error: e.message };
    }
}

function validateYAML(str) {
    try {
        jsyaml.load(str);
        return { valid: true, error: null };
    } catch (e) {
        return { valid: false, error: e.message };
    }
}

// Resolver $ref básico
function resolveRef(spec, ref) {
    if (!ref || !ref.startsWith('#/')) return null;
    const path = ref.substring(2).split('/');
    let current = spec;
    for (const p of path) {
        if (current && typeof current === 'object' && p in current) {
            current = current[p];
        } else {
            return null;
        }
    }
    return current;
}

// ============================================================================
// LAYER A: XML NORMALIZATION LAYER
// Pure helpers for XML traversal - no knowledge of OpenAPI schema
// ============================================================================

/**
 * Parse XML string safely and throw if parser errors are detected
 * Returns Document or throws Error
 */
function parseXmlSafely(xmlString) {
    let xml = xmlString.trim();

    // Verificar se é XML SOAP válido
    try {
        // Primeiro tentar parsear diretamente
        const doc = new DOMParser().parseFromString(xml, 'text/xml');
        
        // Verificar erros de parser
        const parserErrors = doc.getElementsByTagName('parsererror');
        if (parserErrors.length > 0) {
            // Tentar corrigir problemas comuns
            let correctedXml = xml;
            
            // Corrigir namespaces com espaços
            correctedXml = correctedXml.replace(/xmlns:\s*"/g, 'xmlns="');
            correctedXml = correctedXml.replace(/xmlns\s*:\s*([^=]+)\s*=\s*"/g, 'xmlns:$1="');
            
            // Corrigir aspas em URLs de namespace
            correctedXml = correctedXml.replace(/xmlns[^=]*=\s*"\s*`([^`]+)`\s*"/g, 'xmlns="$1"');
            
            // Tentar parsear novamente
            const correctedDoc = new DOMParser().parseFromString(correctedXml, 'text/xml');
            const newErrors = correctedDoc.getElementsByTagName('parsererror');
            
            if (newErrors.length === 0) {
                return correctedDoc;
            }
        }
        
        // Se não houver erros, retornar o documento
        if (parserErrors.length === 0) {
            return doc;
        }
        
    } catch (e) {
        console.warn('Erro ao parsear XML:', e);
    }

    // Se ainda falhar, tentar wrap com root element
    if (!xml.startsWith('<') || xml.match(/<\/\w+>\s*<\w+/)) {
        xml = `<__root__>${xml}</__root__>`;
        const wrappedDoc = new DOMParser().parseFromString(xml, 'text/xml');
        const wrappedErrors = wrappedDoc.getElementsByTagName('parsererror');
        
        if (wrappedErrors.length === 0) {
            return wrappedDoc;
        }
    }

    throw new Error('Invalid XML input - verifique a sintaxe do XML, especialmente os namespaces');
}

function looksLikeMojibake(value) {
    if (!value || typeof value !== 'string') return false;
    return /Ã.|Â.|â[\u0080-\u00BF]|�/.test(value);
}

function repairMojibake(value) {
    if (value === null || value === undefined) return value;
    let text = String(value);
    if (!looksLikeMojibake(text)) return text;

    for (let i = 0; i < 2; i++) {
        try {
            const bytes = new Uint8Array(text.length);
            for (let j = 0; j < text.length; j++) {
                bytes[j] = text.charCodeAt(j) & 0xFF;
            }
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (!decoded || decoded === text) break;
            text = decoded;
        } catch (e) {
            break;
        }
        if (!looksLikeMojibake(text)) break;
    }

    return text;
}

/**
 * Get localName from XML node (ignores namespaces)
 */
function getLocalName(node) {
    if (typeof node === 'string') return node;
    if (node.localName) return node.localName;
    if (node.nodeName) {
        const parts = node.nodeName.split(':');
        return parts[parts.length - 1];
    }
    return node;
}

/**
 * Alias for getLocalName - used for namespace-agnostic matching
 */
function local(node) {
    return getLocalName(node);
}

/**
 * Get root element from Document or Element
 */
function getRootElement(xmlContext) {
    if (!xmlContext) return null;
    if (xmlContext.documentElement) return xmlContext.documentElement;
    if (xmlContext.nodeType === 1) return xmlContext; // ELEMENT_NODE
    return null;
}

/**
 * Find direct child element by localName (returns first match or null)
 */
function findChildByLocalName(parentNode, localName) {
    if (!parentNode || !localName) return null;
    const children = parentNode.childNodes || [];
    
    // First pass: exact match
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeType === 1 && getLocalName(child) === localName) {
            return child;
        }
    }
    
    // Second pass: case-insensitive
    const lowerName = localName.toLowerCase();
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeType === 1 && getLocalName(child).toLowerCase() === lowerName) {
            return child;
        }
    }
    
    return null;
}

/**
 * Find direct child elements by localName (case-sensitive first, then case-insensitive)
 */
function findChildElementsByLocalName(parentNode, localName) {
    if (!parentNode || !localName) return [];
    const results = [];
    const children = parentNode.childNodes || [];
    
    // First pass: exact match
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeType === 1 && getLocalName(child) === localName) {
            results.push(child);
        }
    }
    
    // Second pass: case-insensitive if no exact match
    if (results.length === 0) {
        const lowerName = localName.toLowerCase();
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child.nodeType === 1 && getLocalName(child).toLowerCase() === lowerName) {
                results.push(child);
            }
        }
    }
    
    return results;
}

/**
 * Find all children by localName (returns array)
 */
function findChildrenByLocalName(parentNode, localName) {
    return findChildElementsByLocalName(parentNode, localName);
}

/**
 * Get direct children elements by localName (non-recursive)
 */
function getDirectChildrenByLocalName(parent, name) {
    if (!parent || !name) return [];
    const results = [];
    const children = parent.childNodes || [];
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeType === 1 && local(child) === name) {
            results.push(child);
        }
    }
    return results;
}

/**
 * Find all descendants by localName (recursive)
 */
function findDescendantsByLocalName(parent, name) {
    return findAllElementsByLocalName(parent, name);
}

/**
 * Singularize a plural name (basic rules)
 */
function singularize(name) {
    if (!name || name.length < 2) return name;
    if (name.endsWith('es') && name.length > 2) {
        return name.slice(0, -2);
    }
    if (name.endsWith('s')) {
        return name.slice(0, -1);
    }
    return name;
}

/**
 * Find the best matching element for an object schema
 * Scores elements by how many schema properties they contain
 */
function bestMatchElementForObject(parent, schemaProperties) {
    if (!parent || !schemaProperties) return null;
    
    const propertyNames = Object.keys(schemaProperties);
    if (propertyNames.length === 0) return null;
    
    let bestElement = null;
    let bestScore = 0;
    
    const children = parent.childNodes || [];
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeType !== 1) continue;
        
        let score = 0;
        for (const propName of propertyNames) {
            // Check attribute
            if (child.hasAttribute && child.hasAttribute(propName)) {
                score += 2;
            }
            // Check direct child element
            const childElement = findChildByLocalName(child, propName);
            if (childElement) {
                score += 2;
            }
        }
        
        if (score > bestScore) {
            bestScore = score;
            bestElement = child;
        }
    }
    
    return bestElement;
}

/**
 * Find all descendant elements by localName (recursive search)
 */
function findAllElementsByLocalName(xmlContext, localName) {
    if (!xmlContext || !localName) return [];
    const results = [];
    const root = getRootElement(xmlContext);
    if (!root) return [];
    
    const walker = (node) => {
        if (node.nodeType === 1) { // ELEMENT_NODE
            if (getLocalName(node) === localName) {
                results.push(node);
            }
            for (let i = 0; i < node.childNodes.length; i++) {
                walker(node.childNodes[i]);
            }
        }
    };
    walker(root);
    return results;
}

/**
 * Get attribute value by name (case-sensitive first, then case-insensitive)
 */
function getAttributeValue(xmlNode, attrName) {
    if (!xmlNode || !xmlNode.attributes || !attrName) return undefined;
    
    // First try exact match
    for (let i = 0; i < xmlNode.attributes.length; i++) {
        const attr = xmlNode.attributes[i];
        const attrLocalName = getLocalName(attr);
        if (attrLocalName === attrName || attr.name === attrName) {
            return repairMojibake(attr.value);
        }
    }
    
    // Then try case-insensitive
    const lowerName = attrName.toLowerCase();
    for (let i = 0; i < xmlNode.attributes.length; i++) {
        const attr = xmlNode.attributes[i];
        const attrLocalName = getLocalName(attr);
        if (attrLocalName.toLowerCase() === lowerName || attr.name.toLowerCase() === lowerName) {
            return repairMojibake(attr.value);
        }
    }
    
    return undefined;
}

/**
 * Extract primitive value from XML node for a given field name
 * Only returns value if there's a direct match (attribute or child element)
 * Never uses parent context textContent
 */
function extractPrimitive(node, fieldName) {
    if (!node) return undefined;
    
    // Attribute first (case-insensitive)
    const attrValue = getAttributeValue(node, fieldName);
    if (attrValue !== undefined && attrValue !== '') return attrValue;
    
    // Direct child element (case-insensitive matching)
    const lowerFieldName = fieldName.toLowerCase();
    const children = node.childNodes || [];
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeType === 1) {
            if (local(child).toLowerCase() === lowerFieldName || local(child) === fieldName) {
                const text = repairMojibake(child.textContent?.trim());
                if (text !== undefined && text !== '') return text;
            }
        }
    }
    
    return undefined;
}

function convertXmlValue(value, schemaOrType) {
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

/**
 * Select the best payload node from XML document based on schema root properties
 * Scores candidates by how many schema properties they contain
 */
function selectBestPayloadNode(xmlDoc, schemaRoot) {
    if (!xmlDoc || !xmlDoc.documentElement) return null;
    
    const candidates = [...xmlDoc.getElementsByTagName('*')];
    
    let best = null;
    let bestScore = 0;
    
    if (schemaRoot?.properties) {
        for (const el of candidates) {
            let score = 0;
            
            for (const key of Object.keys(schemaRoot.properties)) {
                // Check attribute
                if (el.hasAttribute(key)) {
                    score++;
                } else {
                    // Check child elements
                    const childNodes = el.childNodes || [];
                    for (let i = 0; i < childNodes.length; i++) {
                        const child = childNodes[i];
                        if (child.nodeType === 1 && local(child) === key) {
                            score++;
                            break;
                        }
                    }
                }
            }
            
            if (score > bestScore) {
                best = el;
                bestScore = score;
            }
        }
    }
    
    return best || xmlDoc.documentElement;
}

// ============================================================================
// LAYER B: SCHEMA INTROSPECTION LAYER
// Helpers for schema resolution and type detection
// ============================================================================

/**
 * Resolve schema reference and return resolved schema
 */
function resolveSchema(schema, spec) {
    if (!schema) return null;
    if (schema.$ref) {
        const resolved = resolveRef(spec, schema.$ref);
        if (resolved) return resolveSchema(resolved, spec);
        return null;
    }
    return schema;
}

/**
 * Determine the effective type of a schema node
 */
function getSchemaType(schema, spec) {
    const resolved = resolveSchema(schema, spec);
    if (!resolved) return null;
    if (resolved.type) return resolved.type;
    if (resolved.properties) return 'object';
    if (resolved.items) return 'array';
    return null;
}

/**
 * Get properties for an object schema
 */
function getSchemaProperties(schema, spec) {
    const resolved = resolveSchema(schema, spec);
    if (!resolved || !resolved.properties) return {};
    return resolved.properties;
}

/**
 * Get items schema for an array schema
 */
function getSchemaItems(schema, spec) {
    const resolved = resolveSchema(schema, spec);
    if (!resolved || !resolved.items) return null;
    return resolved.items;
}

/**
 * Determine the logical item name for an array
 * Tries to infer from schema.items or uses singular form of array property name
 */
function getArrayItemName(arrayPropertyName, itemsSchema, spec) {
    const resolved = resolveSchema(itemsSchema, spec);
    if (resolved && resolved.properties) {
        // If items is an object, try to find a common pattern
        // For now, use singular form heuristic
        if (arrayPropertyName.endsWith('s')) {
            return arrayPropertyName.slice(0, -1);
        }
    }
    // Default: use singular form or the property name itself
    if (arrayPropertyName.endsWith('s') && arrayPropertyName.length > 1) {
        return arrayPropertyName.slice(0, -1);
    }
    return arrayPropertyName;
}

function mapXmlToJson(xml, schema, spec, options = {}) {
    const { includeEmptyFields = false } = options;
    const errors = [];

    function mapNode(xmlNode, schemaNode) {
        if (!xmlNode || !schemaNode) return undefined;

        const resolvedSchema = resolveSchema(schemaNode, spec);
        if (!resolvedSchema) {
            errors.push({ message: `Não foi possível resolver o esquema para o nó XML: ${getLocalName(xmlNode)}` });
            return undefined;
        }

        const schemaType = getSchemaType(resolvedSchema, spec);

        if (schemaType === 'object') {
            const obj = {};
            const properties = getSchemaProperties(resolvedSchema, spec);
            
            Object.keys(properties).forEach(propName => {
                const propSchema = properties[propName];
                const value = mapNode(xmlNode, propSchema);
                if (value !== undefined || includeEmptyFields) {
                    obj[propName] = value;
                }
            });
            return obj;
        }
    }
}

// Funções auxiliares (parseYAML, resolveRef, etc.) aqui...

function generateExampleFromSchema(schema, spec) {
    // Esta função precisa ser implementada ou copiada
    return {};
}

function sanitizeFilename(name) {
    return name.replace(/[^a-z0-9_.]/gi, '_').toLowerCase();
}

const CURL_HISTORY_LIMIT = 40;
const CURL_SPEC_HISTORY_KEY = 'openapi_toolbox_curl_saved_specs_v1';
const CURL_XML_HISTORY_KEY = 'openapi_toolbox_curl_saved_xml_v1';

function buildTimestampToken(date = new Date()) {
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

function safeReadHistory(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.warn('Erro ao ler histórico local:', e);
        return [];
    }
}

function upsertHistoryEntry(key, entry) {
    const list = safeReadHistory(key);
    const normalized = (entry.content || '').trim();
    const existingIdx = list.findIndex(item => (item.content || '').trim() === normalized);
    let updated;
    if (existingIdx >= 0) {
        const existing = list[existingIdx];
        const merged = {
            ...existing,
            ...entry,
            id: existing.id,
            createdAt: existing.createdAt || entry.createdAt
        };
        updated = [merged, ...list.filter((_, idx) => idx !== existingIdx)];
    } else {
        updated = [entry, ...list];
    }

    const trimmed = updated.slice(0, CURL_HISTORY_LIMIT);
    try {
        localStorage.setItem(key, JSON.stringify(trimmed));
    } catch (e) {
        console.warn('Erro ao guardar histórico local:', e);
    }
    return trimmed;
}

function pruneEmptyFields(obj) {
    if (obj === null || obj === undefined) return undefined;
    if (typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
        const newArr = obj.map(pruneEmptyFields).filter(v => v !== undefined && v !== null && (typeof v !== 'object' || Object.keys(v).length > 0));
        return newArr.length > 0 ? newArr : undefined;
    }

    const newObj = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const value = pruneEmptyFields(obj[key]);
            if (value !== undefined && value !== null && value !== '' && (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0)) {
                newObj[key] = value;
            }
        }
    }
    return Object.keys(newObj).length > 0 ? newObj : undefined;
}

function mapBySchema(schema, context, spec) {
    const resolvedSchema = resolveSchema(schema, spec);
    const result = {};

    if (!resolvedSchema || !resolvedSchema.properties) return result;

    for (const [key, propSchema] of Object.entries(resolvedSchema.properties)) {
        const xmlNode = findMatchingXmlNode(key, propSchema, context, spec);
        if (xmlNode) {
            const resolvedPropSchema = resolveSchema(propSchema, spec);
            if (resolvedPropSchema.type === 'object' && resolvedPropSchema.properties) {
                result[key] = mapBySchema(resolvedPropSchema, xmlNode, spec);
            } else if (resolvedPropSchema.type === 'array' && resolvedPropSchema.items) {
                const itemSchema = resolveSchema(resolvedPropSchema.items, spec);
                const itemNodes = findMatchingXmlNode(itemSchema.xml?.name || key, itemSchema, xmlNode, spec, true);
                
                const itemNodeList = Array.from(itemNodes);
                if(itemNodeList.length > 0) {
                    result[key] = itemNodeList.map(itemNode => {
                        if (itemSchema.type === 'object') {
                            return mapBySchema(itemSchema, itemNode, spec);
                        } else {
                            return convertXmlValue(itemNode.textContent, itemSchema);
                        }
                    });
                }

            } else {
                result[key] = convertXmlValue(xmlNode.textContent, resolvedPropSchema);
            }
        }
    }
    return result;
}

// TAB 3: Gerador cURL
function CurlGenerator() {
    const [spec, setSpec] = useState(null);
    const [specText, setSpecText] = useState('');
    const [xmlText, setXmlText] = useState('');
    const [operations, setOperations] = useState([]);
    const [selectedOp, setSelectedOp] = useState(null);
    const [opSearchTerm, setOpSearchTerm] = useState('');
    const [mappingData, setMappingData] = useState(null);
    const [curlOutput, setCurlOutput] = useState('');
    const [showMappingModal, setShowMappingModal] = useState(false);
    const [bodyOnlyWithValues, setBodyOnlyWithValues] = useState(true);

    const [dirHandle, setDirHandle] = useState(null);
    const [availableSpecs, setAvailableSpecs] = useState([]);
    const [availableXmls, setAvailableXmls] = useState([]);
    const [savedSpecs, setSavedSpecs] = useState([]);
    const [savedXmls, setSavedXmls] = useState([]);

    useEffect(() => {
        if (curlOutput) {
            hljs.highlightAll();
        }
    }, [curlOutput]);

    useEffect(() => {
        setSavedSpecs(safeReadHistory(CURL_SPEC_HISTORY_KEY));
        setSavedXmls(safeReadHistory(CURL_XML_HISTORY_KEY));
    }, []);

    const formatHistoryDate = (isoDate) => {
        if (!isoDate) return 'sem data';
        const date = new Date(isoDate);
        return Number.isNaN(date.getTime()) ? 'sem data' : date.toLocaleString();
    };

    const saveValidatedSpecToHistory = (parsedSpec, content, extension) => {
        const title = parsedSpec?.info?.title || 'openapi_spec';
        const version = parsedSpec?.info?.version || 'v1';
        const name = `${sanitizeFilename(title)}_${sanitizeFilename(version)}_${buildTimestampToken()}.${extension}`;
        const entry = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name,
            content,
            createdAt: new Date().toISOString(),
            title,
            version
        };
        const updated = upsertHistoryEntry(CURL_SPEC_HISTORY_KEY, entry);
        setSavedSpecs(updated);
        return name;
    };

    const saveValidatedXmlToHistory = (content, selectedOperation, parsedSpec) => {
        const title = parsedSpec?.info?.title || 'openapi_spec';
        const opId = selectedOperation?.operationId || `${selectedOperation?.method || 'op'}_${selectedOperation?.path || 'request'}`;
        const name = `${sanitizeFilename(title)}_${sanitizeFilename(opId)}_example_${buildTimestampToken()}.xml`;
        const entry = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name,
            content,
            createdAt: new Date().toISOString(),
            operationId: selectedOperation?.operationId || ''
        };
        const updated = upsertHistoryEntry(CURL_XML_HISTORY_KEY, entry);
        setSavedXmls(updated);
        return name;
    };

    const handleConnectFolder = async () => {
        try {
            const handle = await window.showDirectoryPicker();
            setDirHandle(handle);
            loadFilesFromHandle(handle);
        } catch (e) {
            console.error('Erro ao conectar pasta:', e);
        }
    };

    const loadFilesFromHandle = async (handle) => {
        if (!handle) return;
        const specs = [];
        const xmls = [];
        for await (const entry of handle.values()) {
            if (entry.kind === 'file') {
                if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml') || entry.name.endsWith('.json')) {
                    specs.push(entry);
                }
                if (entry.name.endsWith('.xml')) {
                    xmls.push(entry);
                }
            }
        }
        setAvailableSpecs(specs);
        setAvailableXmls(xmls);
    };

    const handleLoadFile = async (fileHandle, type) => {
        try {
            const file = await fileHandle.getFile();
            const content = await file.text();
            if (type === 'spec') {
                setSpecText(content);
            } else if (type === 'xml') {
                setXmlText(content);
            }
        } catch (e) {
            console.error('Erro ao carregar ficheiro:', e);
            alert('Não foi possível ler o ficheiro.');
        }
    };
    
    const saveFile = async (filename, content) => {
        if (!dirHandle) return;
        try {
            const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(content);
            await writable.close();
        } catch (e) {
            console.error('Erro ao salvar ficheiro:', e);
            // Fallback para download se a API falhar
            downloadFile(filename, content);
        }
    };

    const downloadFile = (filename, content) => {
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    };

    const handleLoadSpec = () => {
        if (!specText.trim()) return;

        let parsed;
        let specExtension = 'yaml';
        try {
            const jsonResult = validateJSON(specText);
            if (jsonResult.valid) {
                parsed = JSON.parse(specText);
                specExtension = 'json';
            } else {
                const yamlResult = validateYAML(specText);
                if (!yamlResult.valid) {
                    alert('Spec inválida');
                    return;
                }
                parsed = parseYAML(specText);
            }
        } catch (e) {
            alert(`Erro: ${e.message}`);
            return;
        }

        setSpec(parsed);

        // Guardar spec validada em histórico local
        let generatedSpecName = null;
        try {
            generatedSpecName = saveValidatedSpecToHistory(parsed, specText, specExtension);
        } catch (e) {
            console.error('Erro ao guardar spec no histórico local:', e);
        }

        // Guardar também no diretório ligado, se existir
        if (generatedSpecName) {
            try {
                saveFile(generatedSpecName, specText);
            } catch (e) {
                console.error('Erro ao salvar arquivo:', e);
            }
        }

        const ops = [];
        if (parsed.paths) {
            for (const [path, methods] of Object.entries(parsed.paths)) {
                for (const [method, operation] of Object.entries(methods)) {
                    if (!['get', 'post', 'put', 'delete', 'patch'].includes(method.toLowerCase())) continue;
                    ops.push({
                        path,
                        method: method.toUpperCase(),
                        operation,
                        operationId: operation.operationId || `${method.toUpperCase()} ${path}`
                    });
                }
            }
        }
        setOperations(ops);
    };

    const handlePrepareMapping = () => {
        if (!spec || !selectedOp) {
            alert('Carregue uma spec e selecione uma operação.');
            return;
        }

        const requestBody = selectedOp.operation.requestBody;
        if (!requestBody) {
            alert('Operação não tem request body.');
            return;
        }

        const jsonContent = requestBody.content?.['application/json'];
        const bodySchema = jsonContent?.schema;

        if (!bodySchema) {
            alert('Não foi encontrado schema "application/json" para o request body.');
            return;
        }

        let bodyData = jsonContent?.example ? (typeof jsonContent.example === 'string' ? JSON.parse(jsonContent.example) : jsonContent.example) : generateExampleFromSchema(bodySchema, spec);

        if (xmlText && bodySchema) {
            try {
                let cleanedXml = xmlText.replace(/`\\s*/g, '').replace(/\\s*`/g, '');
                let contentToParse = cleanedXml;
                const messageMatch = cleanedXml.match(new RegExp('<message>([\\s\\S]*)<\\/message>', 'i'));
                if (messageMatch && messageMatch[1]) {
                    contentToParse = messageMatch[1].trim();
                }

                let xmlToMap = contentToParse;
                const soapBodyMatch = contentToParse.match(new RegExp('<(\\w+:)?Body>([\\s\\S]*)<\\/(\\w+:)?Body>', 'i'));
                if (soapBodyMatch && soapBodyMatch[2]) {
                    xmlToMap = soapBodyMatch[2].trim();
                }

                const xmlDoc = parseXmlSafely(xmlToMap);
                const resolvedBodySchema = resolveSchema(bodySchema, spec);
                const bestContext = selectBestPayloadNode(xmlDoc, resolvedBodySchema || bodySchema);

                if (!bestContext) {
                    throw new Error('Não foi possível encontrar um nó de contexto XML adequado.');
                }

                const mappedData = mapBySchema(bodySchema, bestContext, spec);

                if (mappedData !== undefined) {
                    bodyData = mappedData;
                }
            } catch (e) {
                alert(`Erro ao mapear XML: ${e.message}`);
                console.warn('Erro ao mapear XML:', e);
            }
        }

        setMappingData({ bodyData });
        setShowMappingModal(true);

        // Guardar XML validado em histórico local e na pasta ligada
        if (xmlText && selectedOp) {
            try {
                const cleanedXml = xmlText.replace(/`\s*/g, '').replace(/\s*`/g, '');
                parseXmlSafely(cleanedXml);
                const generatedXmlName = saveValidatedXmlToHistory(xmlText, selectedOp, spec);
                saveFile(generatedXmlName, xmlText);
            } catch (e) {
                console.warn('XML não foi guardado no histórico por falha de validação:', e);
            }
        }
    };

    const handleGenerateCurl = () => {
        if (!spec || !selectedOp || !mappingData) {
            alert('Dados de mapeamento não encontrados. Prepare o mapeamento primeiro.');
            return;
        }

        const { bodyData } = mappingData;
        const server = spec.servers && spec.servers[0] ? spec.servers[0].url : 'https://api.example.com';
        let path = selectedOp.path;

        const finalBody = bodyOnlyWithValues ? pruneEmptyFields(bodyData) : bodyData;

        let curl = `curl --location --request ${selectedOp.method} '${server}${path}' \\\n`;
        curl += `--header 'Content-Type: application/json' \\\n`;
        curl += `--data-raw '${JSON.stringify(finalBody, null, 2)}'`;

        setCurlOutput(curl);
        setShowMappingModal(false);

        // Save cURL to file
        const opId = selectedOp.operationId || 'curl_command';
        const filename = `${sanitizeFilename(opId)}.sh`;
        saveFile(filename, curl);
    };

    const handleCopyCurl = () => {
        if (curlOutput) {
            const lines = curlOutput.split('\n');
            const curlStartIndex = lines.findIndex(l => l.trim().startsWith('curl'));
            const textToCopy = curlStartIndex !== -1 
                ? lines.slice(curlStartIndex).join('\n') 
                : curlOutput;

            navigator.clipboard.writeText(textToCopy).then(() => {
                alert('cURL copiado!');
            });
        }
    };

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Coluna da Esquerda */}
            <div className="space-y-4">
                {/* Conectar Pasta */}
                <div>
                    <button onClick={handleConnectFolder} className="w-full bg-blue-600 text-white p-2 rounded-md hover:bg-blue-700">
                        Conectar Pasta de Trabalho
                    </button>
                    {dirHandle && <p className="text-sm text-green-600 mt-2">Pasta conectada: {dirHandle.name}</p>}
                </div>

                {/* Selecionar Spec */}
                {availableSpecs.length > 0 && (
                    <div>
                        <label className="block text-sm font-medium text-gray-700">Specs Disponíveis</label>
                        <select onChange={(e) => handleLoadFile(availableSpecs.find(f => f.name === e.target.value), 'spec')} className="w-full p-2 border border-gray-300 rounded-md">
                            <option value="">Selecione uma Spec...</option>
                            {availableSpecs.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
                        </select>
                    </div>
                )}

                {savedSpecs.length > 0 && (
                    <div>
                        <label className="block text-sm font-medium text-gray-700">
                            Specs Validadas (Local) ({savedSpecs.length})
                        </label>
                        <select onChange={(e) => {
                            const item = savedSpecs.find(f => f.id === e.target.value);
                            if (item) setSpecText(item.content);
                        }} className="w-full p-2 border border-emerald-300 rounded-md bg-emerald-50">
                            <option value="">Selecione uma Spec validada...</option>
                            {savedSpecs.map(item => (
                                <option key={item.id} value={item.id}>
                                    {item.name} ({formatHistoryDate(item.createdAt)})
                                </option>
                            ))}
                        </select>
                    </div>
                )}

                {/* Área da Spec */}
                <div>
                    <label className="block text-sm font-medium text-gray-700">OpenAPI Spec (YAML/JSON)</label>
                    <textarea value={specText} onChange={(e) => setSpecText(e.target.value)} className="w-full h-40 p-2 border border-gray-300 rounded-md font-mono text-sm" />
                    <button onClick={handleLoadSpec} className="mt-2 w-full bg-green-600 text-white p-2 rounded-md hover:bg-green-700">Carregar Spec</button>
                </div>

                {/* Selecionar XML */}
                {availableXmls.length > 0 && (
                    <div>
                        <label className="block text-sm font-medium text-gray-700">XMLs Disponíveis</label>
                        <select onChange={(e) => handleLoadFile(availableXmls.find(f => f.name === e.target.value), 'xml')} className="w-full p-2 border border-gray-300 rounded-md">
                            <option value="">Selecione um XML...</option>
                            {availableXmls.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
                        </select>
                    </div>
                )}

                {savedXmls.length > 0 && (
                    <div>
                        <label className="block text-sm font-medium text-gray-700">
                            XMLs Validados (Local) ({savedXmls.length})
                        </label>
                        <select onChange={(e) => {
                            const item = savedXmls.find(f => f.id === e.target.value);
                            if (item) setXmlText(item.content);
                        }} className="w-full p-2 border border-emerald-300 rounded-md bg-emerald-50">
                            <option value="">Selecione um XML validado...</option>
                            {savedXmls.map(item => (
                                <option key={item.id} value={item.id}>
                                    {item.name} ({formatHistoryDate(item.createdAt)})
                                </option>
                            ))}
                        </select>
                    </div>
                )}

                {/* Área do XML */}
                <div>
                    <label className="block text-sm font-medium text-gray-700">XML de Exemplo</label>
                    <textarea value={xmlText} onChange={(e) => setXmlText(e.target.value)} className="w-full h-40 p-2 border border-gray-300 rounded-md font-mono text-sm" />
                </div>
            </div>

            {/* Coluna da Direita */}
            <div className="space-y-4">
                {/* Operações */}
                {operations.length > 0 && (
                    <div>
                        <label className="block text-sm font-medium text-gray-700">Operações</label>
                        <input type="text" placeholder="Pesquisar operação..." value={opSearchTerm} onChange={(e) => setOpSearchTerm(e.target.value)} className="w-full p-2 border border-gray-300 rounded-md mb-2" />
                        <select
                            value={selectedOp ? selectedOp.operationId : ''}
                            onChange={(e) => setSelectedOp(operations.find(op => op.operationId === e.target.value))}
                            className="w-full p-2 border border-gray-300 rounded-md h-32"
                            multiple
                        >
                            {operations
                                .filter(op => op.operationId.toLowerCase().includes(opSearchTerm.toLowerCase()))
                                .map(op => (
                                    <option key={op.operationId} value={op.operationId}>
                                        {op.method} - {op.path}
                                    </option>
                                ))}
                        </select>
                    </div>
                )}

                {/* Botões de Ação */}
                {selectedOp && (
                    <div className="flex gap-2">
                        <button onClick={handlePrepareMapping} className="flex-1 bg-yellow-600 text-white p-2 rounded-md hover:bg-yellow-700">Preparar Mapeamento</button>
                        <button onClick={() => setShowMappingModal(true)} className="flex-1 bg-blue-500 text-white p-2 rounded-md hover:bg-blue-600">Ver Mapeamento</button>
                    </div>
                )}

                {/* Output cURL */}
                {curlOutput && (
                    <div>
                        <label className="block text-sm font-medium text-gray-700">Resultado cURL</label>
                        <pre className="bg-gray-900 text-white p-4 rounded-md overflow-x-auto text-sm">
                            <code className="language-bash">{curlOutput}</code>
                        </pre>
                        <button onClick={handleCopyCurl} className="mt-2 w-full bg-purple-600 text-white p-2 rounded-md hover:bg-purple-700">Copiar cURL</button>
                    </div>
                )}
            </div>

            {/* Modal de Mapeamento */}
            {showMappingModal && mappingData && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                    <div className="bg-white p-6 rounded-lg shadow-xl max-w-3xl w-full">
                        <h3 className="text-lg font-bold mb-4">Mapeamento XML → JSON</h3>
                        <div className="flex items-center mb-4">
                            <input type="checkbox" id="bodyOnly" checked={bodyOnlyWithValues} onChange={(e) => setBodyOnlyWithValues(e.target.checked)} className="mr-2" />
                            <label htmlFor="bodyOnly">Mostrar apenas o body com valores</label>
                        </div>
                        <pre className="bg-gray-100 p-4 rounded-md overflow-auto max-h-96">
                            <code>{JSON.stringify(bodyOnlyWithValues ? pruneEmptyFields(mappingData.bodyData) : mappingData.bodyData, null, 2)}</code>
                        </pre>
                        <div className="mt-4 flex justify-end gap-2">
                            <button onClick={handleGenerateCurl} className="bg-green-600 text-white p-2 rounded-md hover:bg-green-700">Gerar cURL</button>
                            <button onClick={() => setShowMappingModal(false)} className="bg-gray-300 p-2 rounded-md hover:bg-gray-400">Fechar</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default App;

function OpenAPIToPostman() {
    const [specText, setSpecText] = useState('');
    const [validationStatus, setValidationStatus] = useState(null);
    const [collectionJson, setCollectionJson] = useState('');
    const fileInputRef = useRef(null);

    const handleFileLoad = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            setSpecText(event.target.result);
            setValidationStatus(null);
            setCollectionJson('');
        };
        reader.readAsText(file);
    };

    const handleValidate = () => {
        if (!specText.trim()) {
            setValidationStatus({ type: 'error', message: 'Por favor, cole ou carregue uma spec OpenAPI' });
            return;
        }

        let spec;
        let isValid = false;
        let error = null;

        const jsonResult = validateJSON(specText);
        if (jsonResult.valid) {
            try {
                spec = JSON.parse(specText);
                isValid = true;
            } catch (e) {
                error = e.message;
            }
        } else {
            const yamlResult = validateYAML(specText);
            if (yamlResult.valid) {
                try {
                    spec = parseYAML(specText);
                    isValid = true;
                } catch (e) {
                    error = e.message;
                }
            } else {
                error = yamlResult.error;
            }
        }

        if (isValid) {
            setValidationStatus({ type: 'success', message: 'OpenAPI spec válida!' });
        } else {
            setValidationStatus({ type: 'error', message: `Erro: ${error}` });
        }
    };

    const handleFixYAML = () => {
        if (!specText.trim()) return;
        const fixed = fixYAML(specText);
        setSpecText(fixed);
        setValidationStatus({ type: 'info', message: 'YAML corrigido. Valide novamente.' });
    };

    const handleGenerate = () => {
        if (!specText.trim()) {
            setValidationStatus({ type: 'error', message: 'Por favor, cole ou carregue uma spec OpenAPI' });
            return;
        }

        let spec;
        try {
            const jsonResult = validateJSON(specText);
            if (jsonResult.valid) {
                spec = JSON.parse(specText);
            } else {
                const yamlResult = validateYAML(specText);
                if (!yamlResult.valid) {
                    setValidationStatus({ type: 'error', message: 'Spec inválida. Valide primeiro.' });
                    return;
                }
                spec = parseYAML(specText);
            }
        } catch (e) {
            setValidationStatus({ type: 'error', message: `Erro ao processar: ${e.message}` });
            return;
        }

        try {
            const collection = generatePostmanCollection(spec);
            setCollectionJson(JSON.stringify(collection, null, 2));
            setValidationStatus({ type: 'success', message: 'Collection gerada com sucesso!' });
        } catch (e) {
            setValidationStatus({ type: 'error', message: `Erro ao gerar collection: ${e.message}` });
        }
    };

    const handleCopy = () => {
        if (collectionJson) {
            navigator.clipboard.writeText(collectionJson).then(() => {
                setValidationStatus({ type: 'success', message: 'Copiado para clipboard!' });
            });
        }
    };

    const handleExport = () => {
        if (collectionJson) {
            const blob = new Blob([collectionJson], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'postman-collection.json';
            a.click();
            URL.revokeObjectURL(url);
        }
    };

    const handleClear = () => {
        setSpecText('');
        setCollectionJson('');
        setValidationStatus(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    return (
        <div className="space-y-4">
            <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                    OpenAPI Spec (YAML ou JSON)
                </label>
                <textarea
                    value={specText}
                    onChange={(e) => setSpecText(e.target.value)}
                    className="w-full h-64 p-3 border border-gray-300 rounded-md font-mono text-sm"
                    placeholder="Cole aqui a sua OpenAPI spec ou use o botão para carregar um ficheiro..."
                />
            </div>

            <div className="flex flex-wrap gap-2">
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".yaml,.yml,.json"
                    onChange={handleFileLoad}
                    className="hidden"
                    id="file-input"
                />
                <label
                    htmlFor="file-input"
                    className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 cursor-pointer"
                >
                    📄 Carregar ficheiro
                </label>
                <button
                    onClick={handleValidate}
                    className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700"
                >
                    ✅ Validar YAML/JSON
                </button>
                <button
                    onClick={handleFixYAML}
                    className="px-4 py-2 bg-yellow-600 text-white rounded-md hover:bg-yellow-700"
                >
                    🔧 Corrigir YAML
                </button>
                <button
                    onClick={handleGenerate}
                    className="px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700"
                >
                    🚀 Gerar Collection Postman
                </button>
            </div>

            {validationStatus && (
                <div className={`p-3 rounded-md ${
                    validationStatus.type === 'success' ? 'bg-green-100 text-green-800' :
                    validationStatus.type === 'error' ? 'bg-red-100 text-red-800' :
                    'bg-blue-100 text-blue-800'
                }`}>
                    {validationStatus.message}
                </div>
            )}

            {collectionJson && (
                <div className="space-y-2">
                    <label className="block text-sm font-medium text-gray-700">
                        Postman Collection JSON
                    </label>
                    <textarea
                        readOnly
                        value={collectionJson}
                        className="w-full h-64 p-3 border border-gray-300 rounded-md font-mono text-xs bg-gray-50"
                    />
                    <div className="flex gap-2">
                        <button
                            onClick={handleCopy}
                            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                        >
                            📋 Copiar
                        </button>
                        <button
                            onClick={handleExport}
                            className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700"
                        >
                            💾 Exportar JSON
                        </button>
                        <button
                            onClick={handleClear}
                            className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700"
                        >
                            ❌ Limpar
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

function generatePostmanCollection(spec) {
    const collection = {
        info: {
            name: spec.info.title,
            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
            description: spec.info.description || ''
        },
        item: [],
        variable: [
            {
                key: 'ApigeeHost',
                value: spec.servers && spec.servers[0] ? spec.servers[0].url : 'https://api.example.com',
                type: 'string'
            },
            {
                key: 'key',
                value: '',
                type: 'string'
            },
            {
                key: 'secret',
                value: '',
                type: 'string'
            },
            {
                key: 'bearerToken',
                value: '',
                type: 'string'
            }
        ],
        auth: {
            type: 'bearer',
            bearer: [
                {
                    key: 'token',
                    value: '{{bearerToken}}',
                    type: 'string'
                }
            ]
        }
    };

    const baseHeaders = [
        { key: 'Traceparent', value: '{{$guid}}' },
        { key: 'X-Flow-ID', value: '{{$guid}}' },
        { key: 'X-application', value: 'POSTMAN' },
        { key: 'X-originalApplication', value: 'POSTMAN' },
        { key: 'X-process', value: 'Testing' },
        { key: 'X-user', value: 'U80063362' },
        { key: 'Content-Type', value: 'application/json' },
        { key: 'Accept', value: 'application/json' },
        { key: 'Authorization', value: '{{bearerToken}}' }
    ];

    const authScript = `
const key = pm.environment.get("key") || "";
const secret = pm.environment.get("secret") || "";
const tokenIssuedAt = pm.environment.get("tokenIssuedAt");
const tokenExpiresIn = pm.environment.get("tokenExpiresIn");
const now = Date.now();

// Verificar se token ainda é válido (renovar se faltar menos de 5 minutos)
const shouldRenew = !tokenIssuedAt || !tokenExpiresIn || 
    (now - parseInt(tokenIssuedAt)) > (parseInt(tokenExpiresIn) - 300) * 1000;

if (shouldRenew && key && secret) {
    const authRequest = {
        url: pm.variables.get("ApigeeHost") + "/authentication/v2",
        method: 'POST',
        header: { 'Content-Type': 'application/json' },
        body: {
            mode: 'raw',
            raw: JSON.stringify({ key, secret })
        }
    };
    
    pm.sendRequest(authRequest, (err, res) => {
        if (err || res.code !== 200) {
            // Tentar endpoint alternativo
            authRequest.url = pm.variables.get("ApigeeHost") + "/common/authentication/v1";
            pm.sendRequest(authRequest, (err2, res2) => {
                if (!err2 && res2.code === 200) {
                    const body = res2.json();
                    pm.environment.set("bearerToken", body.access_token || body.token || "");
                    pm.environment.set("tokenIssuedAt", now.toString());
                    pm.environment.set("tokenExpiresIn", (body.expires_in || 3600).toString());
                    pm.environment.set("tokenAuthEndpoint", authRequest.url);
                }
            });
        } else {
            const body = res.json();
            pm.environment.set("bearerToken", body.access_token || body.token || "");
            pm.environment.set("tokenIssuedAt", now.toString());
            pm.environment.set("tokenExpiresIn", (body.expires_in || 3600).toString());
            pm.environment.set("tokenAuthEndpoint", authRequest.url);
        }
    });
}
`;

    if (spec.paths) {
        for (const [path, methods] of Object.entries(spec.paths)) {
            for (const [method, operation] of Object.entries(methods)) {
                if (!['get', 'post', 'put', 'delete', 'patch', 'head', 'options'].includes(method.toLowerCase())) continue;

                const item = {
                    name: operation.operationId || `${method.toUpperCase()} ${path}`,
                    request: {
                        method: method.toUpperCase(),
                        header: [...baseHeaders],
                        url: {
                            raw: `{{ApigeeHost}}${path}`,
                            host: ['{{ApigeeHost}}'],
                            path: path.split('/').filter(p => p)
                        },
                        description: operation.description || operation.summary || ''
                    },
                    response: []
                };

                if (operation.parameters) {
                    const queryParams = operation.parameters
                        .filter(p => p.in === 'query')
                        .map(p => ({
                            key: p.name,
                            value: p.example || p.default || '',
                            description: p.description || ''
                        }));
                    if (queryParams.length > 0) {
                        item.request.url.query = queryParams;
                    }

                    const headerParams = operation.parameters
                        .filter(p => p.in === 'header')
                        .map(p => ({
                            key: p.name,
                            value: p.example || p.default || '',
                            description: p.description || ''
                        }));
                    item.request.header.push(...headerParams);
                }

                const pathParams = path.match(/\\{([^}]+)\\}/g);
                if (pathParams) {
                    if (!item.request.url.variable) item.request.url.variable = [];
                    pathParams.forEach(param => {
                        const name = param.replace(/[{}]/g, '');
                        const paramDef = operation.parameters?.find(p => p.name === name && p.in === 'path');
                        item.request.url.variable.push({
                            key: name,
                            value: paramDef?.example || paramDef?.default || '',
                            description: paramDef?.description || ''
                        });
                    });
                }

                if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) && operation.requestBody) {
                    const jsonContent = operation.requestBody.content?.['application/json'];
                    if (jsonContent) {
                        let bodyData = {};
                        if (jsonContent.example) {
                            bodyData = typeof jsonContent.example === 'string' 
                                ? JSON.parse(jsonContent.example) 
                                : jsonContent.example;
                        } else if (jsonContent.schema) {
                            bodyData = generateExampleFromSchema(jsonContent.schema, spec);
                        }
                        item.request.body = {
                            mode: 'raw',
                            raw: JSON.stringify(bodyData, null, 2),
                            options: {
                                raw: {
                                    language: 'json'
                                }
                            }
                        };
                    }
                }

                item.event = [{
                    listen: 'prerequest',
                    script: {
                        type: 'text/javascript',
                        exec: authScript.split('\n')
                    }
                }];

                collection.item.push(item);
            }
        }
    }

    return collection;
}

function CSVSearch({
    csvData, setCsvData, headers, setHeaders, searchTerm, setSearchTerm,
    filterAvailable, setFilterAvailable, selectedRow, setSelectedRow
}) {
    const fileInputRef = useRef(null);

    const handleFileLoad = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const text = event.target.result;
            const rows = text.split('\n').map(row => row.split(';'));
            const headerRow = rows[0];
            const dataRows = rows.slice(1);

            setHeaders(headerRow);
            setCsvData(dataRows);
            setFilterAvailable(true);
        };
        reader.readAsText(file);
    };

    const filteredData = csvData.filter(row =>
        row.some(cell => cell.toLowerCase().includes(searchTerm.toLowerCase()))
    );

    return (
        <div className="space-y-4">
            <div className="flex gap-2">
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv"
                    onChange={handleFileLoad}
                    className="hidden"
                    id="csv-input"
                />
                <label
                    htmlFor="csv-input"
                    className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 cursor-pointer"
                >
                    📄 Carregar CSV
                </label>
                {filterAvailable && (
                    <input
                        type="text"
                        placeholder="Pesquisar..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full p-2 border border-gray-300 rounded-md"
                    />
                )}
            </div>

            {filteredData.length > 0 && (
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                {headers.map((header, idx) => (
                                    <th key={idx} className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        {header}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {filteredData.map((row, rowIndex) => (
                                <tr key={rowIndex} onClick={() => setSelectedRow(row)} className="hover:bg-gray-100 cursor-pointer">
                                    {row.map((cell, cellIndex) => (
                                        <td key={cellIndex} className="px-6 py-4 whitespace-nowrap text-sm text-gray-800">
                                            {cell}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {selectedRow && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                    <div className="bg-white p-6 rounded-lg shadow-xl max-w-2xl w-full">
                        <h3 className="text-lg font-bold mb-4">Detalhes da Linha</h3>
                        <div className="space-y-2">
                            {headers.map((header, idx) => (
                                <div key={idx}>
                                    <strong className="text-gray-600">{header}:</strong>
                                    <p className="text-gray-800 bg-gray-100 p-2 rounded">{selectedRow[idx]}</p>
                                </div>
                            ))}
                        </div>
                        <button onClick={() => setSelectedRow(null)} className="mt-4 bg-gray-300 p-2 rounded-md hover:bg-gray-400">
                            Fechar
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

function App() {
    const [activeTab, setActiveTab] = useState(0);
    
    // State for CSVSearch
    const [csvData, setCsvData] = useState([]);
    const [csvHeaders, setCsvHeaders] = useState([]);
    const [csvSearchTerm, setCsvSearchTerm] = useState('');
    const [csvFilterAvailable, setCsvFilterAvailable] = useState(false);
    const [csvSelectedRow, setCsvSelectedRow] = useState(null);

    return (
        <div className="max-w-7xl mx-auto px-4">
            <h1 className="text-3xl font-bold text-gray-900 mb-6">OpenAPI Toolbox</h1>
            
            <div className="bg-white rounded-lg shadow-lg">
                <div className="border-b border-gray-200">
                    <nav className="flex space-x-8 px-6">
                        {['OpenAPI → Postman', 'Pesquisa CSV', 'Gerador cURL'].map((tab, idx) => (
                            <button
                                key={idx}
                                onClick={() => setActiveTab(idx)}
                                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                                    activeTab === idx
                                        ? 'border-blue-500 text-blue-600'
                                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                                }`}
                            >
                                {tab}
                            </button>
                        ))}
                    </nav>
                </div>

                <div className="p-6">
                    {activeTab === 0 && <OpenAPIToPostman />}
                    {activeTab === 1 && (
                        <CSVSearch
                            csvData={csvData}
                            setCsvData={setCsvData}
                            headers={csvHeaders}
                            setHeaders={setCsvHeaders}
                            searchTerm={csvSearchTerm}
                            setSearchTerm={setCsvSearchTerm}
                            filterAvailable={csvFilterAvailable}
                            setFilterAvailable={setCsvFilterAvailable}
                            selectedRow={csvSelectedRow}
                            setSelectedRow={setCsvSelectedRow}
                        />
                    )}
                    {activeTab === 2 && <CurlGenerator />}
                </div>
            </div>
        </div>
    );
}
