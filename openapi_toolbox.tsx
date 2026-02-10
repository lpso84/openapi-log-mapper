import React, { useState, useRef, useEffect } from 'react';
import { Upload, FileText, Search, Code, Check, X, AlertCircle, Copy, Download, Trash2, Eye, EyeOff } from 'lucide-react';

// ============================================================================
// TIPOS E INTERFACES
// ============================================================================

interface PostmanHeader {
  key: string;
  value: string;
  description?: string;
}

interface PostmanRequest {
  method: string;
  header: PostmanHeader[];
  body?: {
    mode: string;
    raw: string;
    options?: {
      raw: {
        language: string;
      };
    };
  };
  url: {
    raw: string;
    host: string[];
    path: string[];
    query?: Array<{
      key: string;
      value: string;
      description?: string;
    }>;
  };
}

interface PostmanItem {
  name: string;
  request: PostmanRequest;
  description?: string;
}

// ============================================================================
// UTILIDADES YAML/JSON
// ============================================================================

const tryParseJSON = (text: string): any => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const tryParseYAML = (text: string): any => {
  try {
    // Parser YAML simplificado para casos básicos
    const lines = text.split('\n');
    const result: any = {};
    let currentObj: any = result;
    const stack: any[] = [result];
    let currentIndent = 0;

    for (const line of lines) {
      if (line.trim().startsWith('#') || !line.trim()) continue;
      
      const indent = line.search(/\S/);
      const trimmed = line.trim();
      
      if (trimmed.includes(':')) {
        const [key, ...valueParts] = trimmed.split(':');
        const value = valueParts.join(':').trim();
        
        if (indent < currentIndent) {
          const levels = Math.floor((currentIndent - indent) / 2) + 1;
          for (let i = 0; i < levels && stack.length > 1; i++) {
            stack.pop();
          }
          currentObj = stack[stack.length - 1];
        }
        
        currentIndent = indent;
        
        if (value) {
          currentObj[key.trim()] = value.replace(/^["']|["']$/g, '');
        } else {
          currentObj[key.trim()] = {};
          currentObj = currentObj[key.trim()];
          stack.push(currentObj);
        }
      }
    }
    
    return result;
  } catch {
    return null;
  }
};

const fixYAML = (text: string): string => {
  let fixed = text.replace(/\t/g, '  ');
  
  const lines = fixed.split('\n');
  const fixedLines = lines.map(line => {
    if (line.trim() && !line.includes(':') && !line.trim().startsWith('#')) {
      const match = line.match(/^(\s*)(\S+)\s+(.+)$/);
      if (match) {
        return `${match[1]}${match[2]}: ${match[3]}`;
      }
    }
    return line;
  });
  
  fixed = fixedLines.join('\n');
  fixed = fixed.replace(/\n{3,}/g, '\n\n');
  fixed = fixed.replace(/[^\x20-\x7E\n\r\t]/g, '');
  
  return fixed;
};

// ============================================================================
// GERAÇÃO POSTMAN COLLECTION
// ============================================================================

const CURL_BASE_HEADERS = {
  'User-Agent': 'OutSystemsPlatform',
  'X-application': 'WEBSC',
  'X-process': 'Consultar período fidelização',
  'X-user': 'WEBSC',
  'X-eTrackingID': 'WEBSC-b9bd18f3-82e1-4caa-aa81-57411159b5bb',
  'X-timeout': '3000',
  'X-OP-source-system': 'BSCS',
  'X-OP-flag-inactive': 'TRUE',
  'Content-Type': 'application/json',
  'Authorization': '{{bearerToken}}'
};

const resolveRef = (ref: string, components: any): any => {
  if (!ref || !ref.startsWith('#/')) return null;
  const parts = ref.replace('#/', '').split('/');
  let current = components;
  for (const part of parts) {
    if (!current || !current[part]) return null;
    current = current[part];
  }
  return current;
};

const generateExampleFromSchema = (schema: any, components: any, depth = 0): any => {
  if (depth > 10) return '';
  
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, components);
    if (resolved) return generateExampleFromSchema(resolved, components, depth + 1);
  }
  
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  
  if (schema.type === 'object') {
    const obj: any = {};
    if (schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        obj[key] = generateExampleFromSchema(prop as any, components, depth + 1);
      }
    }
    return obj;
  }
  
  if (schema.type === 'array') {
    if (schema.items) {
      return [generateExampleFromSchema(schema.items, components, depth + 1)];
    }
    return [];
  }
  
  if (schema.type === 'string') return '';
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  if (schema.type === 'boolean') return false;
  
  return '';
};

const generatePostmanCollection = (spec: any): any => {
  const info = spec.info || {};
  const collectionName = info.title || 'API Collection';
  const paths = spec.paths || {};
  const components = spec.components || {};
  
  const items: PostmanItem[] = [];
  
  for (const [path, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== 'object') continue;
    
    const pathParams = (pathItem as any).parameters || [];
    const methods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'];
    
    for (const method of methods) {
      const operation = (pathItem as any)[method];
      if (!operation) continue;
      
      const allParams = [...pathParams, ...(operation.parameters || [])];
      const queryParams = allParams.filter((p: any) => p.in === 'query');
      const headerParams = allParams.filter((p: any) => p.in === 'header');
      
      const headers: PostmanHeader[] = Object.entries(CURL_BASE_HEADERS).map(([key, value]) => ({
        key,
        value
      }));
      
      for (const param of headerParams) {
        if (!headers.find(h => h.key === param.name)) {
          const value = param.example || param.schema?.example || param.schema?.default || '';
          headers.push({
            key: param.name,
            value: String(value),
            description: param.description
          });
        }
      }
      
      const request: PostmanRequest = {
        method: method.toUpperCase(),
        header: headers,
        url: {
          raw: `{{ApigeeHost}}${path}`,
          host: ['{{ApigeeHost}}'],
          path: path.split('/').filter(Boolean),
          query: queryParams.map((p: any) => ({
            key: p.name,
            value: String(p.schema?.default || p.example || ''),
            description: p.description
          }))
        }
      };
      
      if (['post', 'put', 'patch'].includes(method) && operation.requestBody) {
        const content = operation.requestBody.content?.['application/json'];
        if (content) {
          let bodyExample = content.example;
          if (!bodyExample && content.schema) {
            bodyExample = generateExampleFromSchema(content.schema, components);
          }
          
          request.body = {
            mode: 'raw',
            raw: JSON.stringify(bodyExample, null, 2),
            options: {
              raw: {
                language: 'json'
              }
            }
          };
        }
      }
      
      items.push({
        name: path,
        request,
        description: operation.summary || operation.description
      });
    }
  }
  
  const authScript = `
const ApigeeHost = pm.environment.get("ApigeeHost");
const KeyAPIGEE = pm.environment.get("KeyAPIGEE");
const SecretAPIGEE = pm.environment.get("SecretAPIGEE");

if (!ApigeeHost || !KeyAPIGEE || !SecretAPIGEE) {
    console.error("Variáveis de ambiente não configuradas");
    return;
}

const tokenIssuedAt = pm.environment.get("tokenIssuedAt");
const tokenExpiresIn = pm.environment.get("tokenExpiresIn");

if (tokenIssuedAt && tokenExpiresIn) {
    const now = Date.now();
    const elapsed = (now - parseInt(tokenIssuedAt)) / 1000;
    if (elapsed < parseInt(tokenExpiresIn) - 60) {
        return;
    }
}

const authEndpoint = pm.environment.get("tokenAuthEndpoint") || "/authentication/v2";

pm.sendRequest({
    url: ApigeeHost + authEndpoint,
    method: 'POST',
    header: { 'Content-Type': 'application/json' },
    body: {
        mode: 'raw',
        raw: JSON.stringify({ key: KeyAPIGEE, secret: SecretAPIGEE })
    }
}, (err, res) => {
    if (err || !res.json().access_token) {
        pm.sendRequest({
            url: ApigeeHost + "/common/authentication/v1",
            method: 'POST',
            header: { 'Content-Type': 'application/json' },
            body: {
                mode: 'raw',
                raw: JSON.stringify({ key: KeyAPIGEE, secret: SecretAPIGEE })
            }
        }, (err2, res2) => {
            if (!err2 && res2.json().access_token) {
                const data = res2.json();
                pm.environment.set("access_token", data.access_token);
                pm.environment.set("bearerToken", "Bearer " + data.access_token);
                pm.environment.set("tokenIssuedAt", Date.now());
                pm.environment.set("tokenExpiresIn", data.expires_in);
                pm.environment.set("tokenAuthEndpoint", "/common/authentication/v1");
            }
        });
    } else {
        const data = res.json();
        pm.environment.set("access_token", data.access_token);
        pm.environment.set("bearerToken", "Bearer " + data.access_token);
        pm.environment.set("tokenIssuedAt", Date.now());
        pm.environment.set("tokenExpiresIn", data.expires_in);
        pm.environment.set("tokenAuthEndpoint", authEndpoint);
    }
});
`;
  
  return {
    info: {
      name: collectionName,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    },
    auth: {
      type: 'bearer',
      bearer: [
        {
          key: 'token',
          value: '{{access_token}}',
          type: 'string'
        }
      ]
    },
    item: items,
    event: [
      {
        listen: 'prerequest',
        script: {
          type: 'text/javascript',
          exec: authScript.split('\n')
        }
      }
    ],
    variable: [
      { key: 'ApigeeHost', value: '' },
      { key: 'KeyAPIGEE', value: '' },
      { key: 'SecretAPIGEE', value: '' },
      { key: 'access_token', value: '' },
      { key: 'tokenIssuedAt', value: '' },
      { key: 'tokenExpiresIn', value: '' },
      { key: 'bearerToken', value: '' },
      { key: 'tokenAuthEndpoint', value: '' }
    ]
  };
};

// ============================================================================
// COMPONENTE PRINCIPAL
// ============================================================================

export default function OpenAPIToolbox() {
  const [activeTab, setActiveTab] = useState<'postman' | 'csv' | 'curl'>('postman');
  
  // Estado Postman
  const [postmanSpec, setPostmanSpec] = useState('');
  const [postmanFormat, setPostmanFormat] = useState<'json' | 'yaml' | 'invalid'>('invalid');
  const [postmanCollection, setPostmanCollection] = useState('');
  const [postmanStatus, setPostmanStatus] = useState('');
  
  // Estado CSV
  const [csvData, setCsvData] = useState<string[][]>([]);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvSearchText, setCsvSearchText] = useState('');
  const [csvResults, setCsvResults] = useState<string[][]>([]);
  const [csvFilterAvailable, setCsvFilterAvailable] = useState(false);
  const [csvSelectedRow, setCsvSelectedRow] = useState<string[] | null>(null);
  
  // Estado cURL
  const [curlSpec, setCurlSpec] = useState('');
  const [curlXml, setCurlXml] = useState('');
  const [curlOperations, setCurlOperations] = useState<any[]>([]);
  const [curlSelectedOp, setCurlSelectedOp] = useState<any>(null);
  const [curlOutput, setCurlOutput] = useState('');
  const [showMappingModal, setShowMappingModal] = useState(false);
  const [curlIncludeEmpty, setCurlIncludeEmpty] = useState(true);
  
  // Modal mapping state
  const [pathParams, setPathParams] = useState<Array<{active: boolean, key: string, value: string}>>([]);
  const [queryParams, setQueryParams] = useState<Array<{active: boolean, key: string, value: string}>>([]);
  const [headers, setHeaders] = useState<Array<{key: string, value: string, description: string}>>([]);
  const [bodyJson, setBodyJson] = useState('');
  const [showBodyJson, setShowBodyJson] = useState(true);
  const [bodyOnlyWithValues, setBodyOnlyWithValues] = useState(false);
  
  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  // Detectar formato do spec Postman
  useEffect(() => {
    if (!postmanSpec.trim()) {
      setPostmanFormat('invalid');
      setPostmanStatus('');
      return;
    }
    
    const jsonObj = tryParseJSON(postmanSpec);
    if (jsonObj) {
      setPostmanFormat('json');
      setPostmanStatus('✅ JSON válido – pronto para conversão');
      return;
    }
    
    const yamlObj = tryParseYAML(postmanSpec);
    if (yamlObj && Object.keys(yamlObj).length > 0) {
      setPostmanFormat('yaml');
      setPostmanStatus('✅ YAML válido – pronto para conversão');
      return;
    }
    
    setPostmanFormat('invalid');
    setPostmanStatus('Conteúdo não reconhecido como JSON ou YAML válido');
  }, [postmanSpec]);
  
  const handleValidateSpec = () => {
    const jsonObj = tryParseJSON(postmanSpec);
    if (jsonObj) {
      setPostmanStatus('✅ JSON válido!');
      return;
    }
    
    const yamlObj = tryParseYAML(postmanSpec);
    if (yamlObj && Object.keys(yamlObj).length > 0) {
      setPostmanStatus('✅ YAML válido!');
      return;
    }
    
    setPostmanStatus('❌ Erro: formato não reconhecido');
  };
  
  const handleFixYAML = () => {
    const fixed = fixYAML(postmanSpec);
    setPostmanSpec(fixed);
    setPostmanStatus('✅ Correções aplicadas com sucesso');
  };
  
  const handleGenerateCollection = () => {
    try {
      let spec = tryParseJSON(postmanSpec);
      if (!spec) {
        spec = tryParseYAML(postmanSpec);
      }
      
      if (!spec || typeof spec !== 'object') {
        setPostmanStatus('❌ Erro: especificação inválida');
        return;
      }
      
      const collection = generatePostmanCollection(spec);
      setPostmanCollection(JSON.stringify(collection, null, 2));
      setPostmanStatus('✅ Collection gerada com sucesso!');
    } catch (error) {
      setPostmanStatus(`❌ Erro: ${error}`);
    }
  };
  
  const handleCopyCollection = () => {
    navigator.clipboard.writeText(postmanCollection);
    setPostmanStatus('✅ Copiado para clipboard!');
  };
  
  const handleExportCollection = () => {
    const blob = new Blob([postmanCollection], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'collection.json';
    a.click();
    URL.revokeObjectURL(url);
  };
  
  // CSV
  const handleLoadCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length === 0) return;
      
      const headers = lines[0].split(';').map(h => h.trim());
      const data = lines.slice(1).map(line => line.split(';').map(c => c.trim()));
      
      setCsvHeaders(headers);
      setCsvData(data);
      setCsvResults(data);
    };
    reader.readAsText(file);
  };
  
  const handleSearchCSV = () => {
    if (!csvSearchText.trim()) {
      setCsvResults(csvData);
      return;
    }
    
    const query = csvSearchText.toLowerCase();
    let filtered = csvData.filter(row => {
      const combined = row.join(';').toLowerCase();
      return combined.includes(query);
    });
    
    if (csvFilterAvailable) {
      const statusIndex = csvHeaders.findIndex(h => h.toLowerCase() === 'status');
      if (statusIndex >= 0) {
        filtered = filtered.filter(row => row[statusIndex]?.toLowerCase() === 'available');
      }
    }
    
    setCsvResults(filtered);
  };
  
  // cURL
  const handleLoadCurlSpec = () => {
    try {
      let spec = tryParseJSON(curlSpec);
      if (!spec) {
        spec = tryParseYAML(curlSpec);
      }
      
      if (!spec || typeof spec !== 'object') {
        alert('Especificação inválida');
        return;
      }
      
      const paths = spec.paths || {};
      const ops: any[] = [];
      
      for (const [path, pathItem] of Object.entries(paths)) {
        if (typeof pathItem !== 'object') continue;
        
        const methods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'];
        for (const method of methods) {
          const operation = (pathItem as any)[method];
          if (!operation) continue;
          
          const label = `${method.toUpperCase()} ${path}${operation.operationId ? ` (${operation.operationId})` : ''}`;
          ops.push({
            label,
            method: method.toUpperCase(),
            path,
            operation,
            pathItem,
            spec
          });
        }
      }
      
      setCurlOperations(ops);
      alert(`✅ ${ops.length} operações carregadas`);
    } catch (error) {
      alert(`❌ Erro: ${error}`);
    }
  };
  
  const handlePrepareMappingModal = () => {
    if (!curlSelectedOp) {
      alert('Selecione uma operação primeiro');
      return;
    }
    
    if (!curlXml.trim()) {
      alert('Insira o XML de exemplo');
      return;
    }
    
    // Extrair valores do XML (simplificado)
    const xmlValues: Record<string, string> = {};
    const parser = new DOMParser();
    const doc = parser.parseFromString(curlXml, 'text/xml');
    
    const extractValues = (node: Element) => {
      if (node.tagName) {
        const text = node.textContent?.trim() || '';
        if (text && !node.children.length) {
          xmlValues[node.tagName] = text;
        }
        
        for (let i = 0; i < node.attributes.length; i++) {
          const attr = node.attributes[i];
          xmlValues[attr.name] = attr.value;
        }
      }
      
      for (let i = 0; i < node.children.length; i++) {
        extractValues(node.children[i] as Element);
      }
    };
    
    if (doc.documentElement) {
      extractValues(doc.documentElement);
    }
    
    // Path params
    const pathParamsFound: Array<{active: boolean, key: string, value: string}> = [];
    const pathMatches = curlSelectedOp.path.match(/\{([^}]+)\}/g);
    if (pathMatches) {
      pathMatches.forEach((match: string) => {
        const key = match.slice(1, -1);
        const value = xmlValues[key] || '';
        pathParamsFound.push({ active: true, key, value });
      });
    }
    setPathParams(pathParamsFound);
    
    // Query params
    const allParams = [
      ...(curlSelectedOp.pathItem.parameters || []),
      ...(curlSelectedOp.operation.parameters || [])
    ];
    const queryParamsFound = allParams
      .filter((p: any) => p.in === 'query')
      .map((p: any) => ({
        active: true,
        key: p.name,
        value: xmlValues[p.name] || p.schema?.default || p.example || ''
      }));
    setQueryParams(queryParamsFound);
    
    // Headers obrigatórios
    const headerParamsFound = allParams
      .filter((p: any) => p.in === 'header' && p.required && !p.deprecated)
      .map((p: any) => {
        let value = p.example || p.schema?.example || p.schema?.default || '';
        if (!value && CURL_BASE_HEADERS[p.name as keyof typeof CURL_BASE_HEADERS]) {
          value = CURL_BASE_HEADERS[p.name as keyof typeof CURL_BASE_HEADERS];
        }
        
        const description = `[OBRIGATÓRIO] ${p.description || ''}`;
        return { key: p.name, value: String(value), description };
      });
    setHeaders(headerParamsFound);
    
    // Body JSON
    const requestBody = curlSelectedOp.operation.requestBody?.content?.['application/json'];
    if (requestBody) {
      let example = requestBody.example;
      if (!example && requestBody.schema) {
        example = generateExampleFromSchema(requestBody.schema, curlSelectedOp.spec.components || {});
        
        // Mapear valores do XML para o schema
        if (typeof example === 'object' && example !== null) {
          const mapXmlToObject = (obj: any) => {
            for (const key in obj) {
              if (xmlValues[key]) {
                obj[key] = xmlValues[key];
              } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                mapXmlToObject(obj[key]);
              }
            }
          };
          mapXmlToObject(example);
        }
      }
      setBodyJson(JSON.stringify(example, null, 2));
    } else {
      setBodyJson('{}');
    }
    
    setShowMappingModal(true);
  };
  
  const handleGenerateCurl = () => {
    if (!curlSelectedOp) return;
    
    let pathFinal = curlSelectedOp.path;
    pathParams.forEach(p => {
      if (p.active && p.key) {
        pathFinal = pathFinal.replace(`{${p.key}}`, p.value);
      }
    });
    
    const activeQuery = queryParams.filter(q => q.active && q.key);
    const qs = activeQuery.length > 0
      ? '?' + activeQuery.map(q => `${q.key}=${q.value}`).join('&')
      : '';
    
    const curlHeaders = headers
      .filter(h => h.value)
      .map(h => `-H "${h.key}: ${h.value}"`)
      .join(' ');
    
    let body = '';
    if (['POST', 'PUT', 'PATCH'].includes(curlSelectedOp.method)) {
      try {
        const parsed = JSON.parse(bodyJson);
        body = ` --data-raw '${JSON.stringify(parsed)}'`;
      } catch {
        body = bodyJson.trim() ? ` --data-raw '${bodyJson.replace(/\n/g, ' ')}'` : '';
      }
    }
    
    const endpoint = pathFinal + qs;
    const curl = `# ${endpoint}\ncurl -X ${curlSelectedOp.method} "{{ApigeeHost}}${endpoint}" ${curlHeaders}${body}`;
    
    setCurlOutput(curl);
    setShowMappingModal(false);
  };
  
  const handleCopyCurl = () => {
    const lines = curlOutput.split('\n');
    const curlLine = lines.find(l => l.startsWith('curl'));
    navigator.clipboard.writeText(curlLine || curlOutput);
    alert('✅ Copiado!');
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto p-4 max-w-7xl">
        <h1 className="text-3xl font-bold mb-6 text-gray-800">OpenAPI Toolbox</h1>
        
        {/* Tabs */}
        <div className="flex gap-2 mb-6 border-b">
          <button
            onClick={() => setActiveTab('postman')}
            className={`px-6 py-3 font-medium transition-colors ${
              activeTab === 'postman'
                ? 'border-b-2 border-blue-500 text-blue-600'
                : 'text-gray-600 hover:text-gray-800'
            }`}
          >
            <FileText className="inline mr-2" size={18} />
            OpenAPI → Postman
          </button>
          <button
            onClick={() => setActiveTab('csv')}
            className={`px-6 py-3 font-medium transition-colors ${
              activeTab === 'csv'
                ? 'border-b-2 border-blue-500 text-blue-600'
                : 'text-gray-600 hover:text-gray-800'
            }`}
          >
            <Search className="inline mr-2" size={18} />
            Pesquisa CSV
          </button>
          <button
            onClick={() => setActiveTab('curl')}
            className={`px-6 py-3 font-medium transition-colors ${
              activeTab === 'curl'
                ? 'border-b-2 border-blue-500 text-blue-600'
                : 'text-gray-600 hover:text-gray-800'
            }`}
          >
            <Code className="inline mr-2" size={18} />
            Gerador cURL
          </button>
        </div>
        
        {/* Tab: Postman */}
        {activeTab === 'postman' && (
          <div className="space-y-4">
            <div className="bg-white p-6 rounded-lg shadow">
              <h2 className="text-xl font-semibold mb-4">Especificação OpenAPI</h2>
              
              <div className="flex gap-2 mb-4">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 flex items-center gap-2"
                >
                  <Upload size={18} />
                  Carregar ficheiro
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".yaml,.yml,.json"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const reader = new FileReader();
                      reader.onload = (ev) => setPostmanSpec(ev.target?.result as string);
                      reader.readAsText(file);
                    }
                  }}
                />
                <button
                  onClick={handleValidateSpec}
                  className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
                >
                  Validar YAML/JSON
                </button>
                <button
                  onClick={handleFixYAML}
                  className="px-4 py-2 bg-orange-500 text-white rounded hover:bg-orange-600"
                >
                  Corrigir YAML
                </button>
                <button
                  onClick={handleGenerateCollection}
                  className="px-4 py-2 bg-purple-500 text-white rounded hover:bg-purple-600"
                >
                  Gerar Collection Postman
                </button>
              </div>
              
              {postmanStatus && (
                <div className={`p-3 rounded mb-4 ${
                  postmanStatus.includes('✅') ? 'bg-green-50 text-green-700' : 
                  postmanStatus.includes('❌') ? 'bg-red-50 text-red-700' : 
                  'bg-blue-50 text-blue-700'
                }`}>
                  {postmanStatus}
                </div>
              )}
              
              <div className="mb-2 text-sm font-medium text-gray-700">
                {postmanFormat === 'json' && '✅ JSON'}
                {postmanFormat === 'yaml' && '✅ YAML'}
                {postmanFormat === 'invalid' && '⚠️ Formato não reconhecido'}
              </div>
              
              <textarea
                value={postmanSpec}
                onChange={(e) => setPostmanSpec(e.target.value)}
                className="w-full h-96 p-4 border rounded font-mono text-sm"
                placeholder="Cole aqui a especificação OpenAPI (YAML ou JSON)..."
              />
            </div>
            
            {postmanCollection && (
              <div className="bg-white p-6 rounded-lg shadow">
                <h2 className="text-xl font-semibold mb-4">Collection Postman Gerada</h2>
                
                <div className="flex gap-2 mb-4">
                  <button
                    onClick={handleCopyCollection}
                    className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 flex items-center gap-2"
                  >
                    <Copy size={18} />
                    Copiar
                  </button>
                  <button
                    onClick={handleExportCollection}
                    className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 flex items-center gap-2"
                  >
                    <Download size={18} />
                    Exportar JSON
                  </button>
                  <button
                    onClick={() => setPostmanCollection('')}
                    className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 flex items-center gap-2"
                  >
                    <Trash2 size={18} />
                    Limpar
                  </button>
                </div>
                
                <textarea
                  value={postmanCollection}
                  readOnly
                  className="w-full h-96 p-4 border rounded font-mono text-sm bg-gray-50"
                />
              </div>
            )}
          </div>
        )}
        
        {/* Tab: CSV */}
        {activeTab === 'csv' && (
          <div className="space-y-4">
            <div className="bg-white p-6 rounded-lg shadow">
              <h2 className="text-xl font-semibold mb-4">Carregar CSV de Proxies</h2>
              
              <button
                onClick={() => csvInputRef.current?.click()}
                className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 flex items-center gap-2 mb-4"
              >
                <Upload size={18} />
                Carregar proxies_catalog_apigee.csv
              </button>
              <input
                ref={csvInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={handleLoadCSV}
              />
              
              {csvHeaders.length > 0 && (
                <>
                  <div className="flex gap-2 mb-4">
                    <input
                      type="text"
                      value={csvSearchText}
                      onChange={(e) => setCsvSearchText(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSearchCSV()}
                      className="flex-1 px-4 py-2 border rounded"
                      placeholder="Texto a procurar..."
                    />
                    <button
                      onClick={handleSearchCSV}
                      className="px-6 py-2 bg-green-500 text-white rounded hover:bg-green-600"
                    >
                      Procurar
                    </button>
                  </div>
                  
                  <label className="flex items-center gap-2 mb-4">
                    <input
                      type="checkbox"
                      checked={csvFilterAvailable}
                      onChange={(e) => setCsvFilterAvailable(e.target.checked)}
                      className="w-4 h-4"
                    />
                    <span>Só STATUS = available</span>
                  </label>
                  
                  <div className="overflow-auto max-h-96 border rounded">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-100 sticky top-0">
                        <tr>
                          {csvHeaders.map((h, i) => (
                            <th key={i} className="px-4 py-2 text-left font-semibold border-b">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {csvResults.length === 0 ? (
                          <tr>
                            <td colSpan={csvHeaders.length} className="px-4 py-8 text-center text-gray-500">
                              Nenhum registo encontrado{csvSearchText ? ` contendo: ${csvSearchText}` : ''}
                            </td>
                          </tr>
                        ) : (
                          csvResults.map((row, i) => (
                            <tr
                              key={i}
                              onClick={() => setCsvSelectedRow(row)}
                              className={`cursor-pointer hover:bg-blue-50 ${
                                csvSelectedRow === row ? 'bg-blue-100' : ''
                              }`}
                            >
                              {row.map((cell, j) => (
                                <td key={j} className="px-4 py-2 border-b">
                                  {cell}
                                </td>
                              ))}
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                  
                  {csvSelectedRow && (
                    <div className="mt-4 p-4 bg-gray-50 rounded border">
                      <h3 className="font-semibold mb-2">Detalhe da linha selecionada:</h3>
                      <div className="space-y-1 text-sm font-mono">
                        {csvHeaders.map((h, i) => (
                          <div key={i}>
                            <strong>{h}:</strong> {csvSelectedRow[i]}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
        
        {/* Tab: cURL */}
        {activeTab === 'curl' && (
          <div className="space-y-4">
            <div className="bg-white p-6 rounded-lg shadow">
              <h2 className="text-xl font-semibold mb-4">Especificação OpenAPI</h2>
              
              <div className="flex gap-2 mb-4">
                <button
                  onClick={handleLoadCurlSpec}
                  className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                >
                  Validar & Carregar Spec
                </button>
              </div>
              
              <textarea
                value={curlSpec}
                onChange={(e) => setCurlSpec(e.target.value)}
                className="w-full h-64 p-4 border rounded font-mono text-sm mb-4"
                placeholder="Cole aqui a especificação OpenAPI..."
              />
              
              {curlOperations.length > 0 && (
                <>
                  <h3 className="font-semibold mb-2">Selecionar operação:</h3>
                  <select
                    onChange={(e) => {
                      const op = curlOperations[parseInt(e.target.value)];
                      setCurlSelectedOp(op);
                    }}
                    className="w-full px-4 py-2 border rounded mb-2"
                  >
                    <option value="">-- Escolha uma operação --</option>
                    {curlOperations.map((op, i) => (
                      <option key={i} value={i}>
                        {op.label}
                      </option>
                    ))}
                  </select>
                  
                  {curlSelectedOp && (
                    <div className={`p-3 rounded mb-4 ${
                      curlSelectedOp.operation.deprecated
                        ? 'bg-red-50 text-red-700'
                        : 'bg-green-50 text-green-700'
                    }`}>
                      {curlSelectedOp.operation.deprecated
                        ? '⚠️ Esta operação está marcada como deprecated na especificação.'
                        : '✅ Operação não está marcada como deprecated na especificação.'}
                    </div>
                  )}
                </>
              )}
            </div>
            
            <div className="bg-white p-6 rounded-lg shadow">
              <h2 className="text-xl font-semibold mb-4">XML de Exemplo</h2>
              
              <label className="flex items-center gap-2 mb-4">
                <input
                  type="checkbox"
                  checked={curlIncludeEmpty}
                  onChange={(e) => setCurlIncludeEmpty(e.target.checked)}
                  className="w-4 h-4"
                />
                <span>Incluir campos em falta com "" no JSON</span>
              </label>
              
              <textarea
                value={curlXml}
                onChange={(e) => setCurlXml(e.target.value)}
                className="w-full h-64 p-4 border rounded font-mono text-sm mb-4"
                placeholder="Cole aqui o XML de exemplo..."
              />
              
              <button
                onClick={handlePrepareMappingModal}
                className="px-6 py-2 bg-purple-500 text-white rounded hover:bg-purple-600"
              >
                Preparar mapeamento
              </button>
            </div>
            
            {curlOutput && (
              <div className="bg-white p-6 rounded-lg shadow">
                <h2 className="text-xl font-semibold mb-4">cURL Gerado</h2>
                
                <button
                  onClick={handleCopyCurl}
                  className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 flex items-center gap-2 mb-4"
                >
                  <Copy size={18} />
                  Copiar cURL
                </button>
                
                <textarea
                  value={curlOutput}
                  readOnly
                  className="w-full h-48 p-4 border rounded font-mono text-sm bg-gray-50"
                />
              </div>
            )}
          </div>
        )}
        
        {/* Modal de Mapeamento */}
        {showMappingModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-lg shadow-xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col">
              <div className="p-6 border-b flex justify-between items-center">
                <h2 className="text-2xl font-bold">Mapeamento de Dados</h2>
                <button
                  onClick={() => setShowMappingModal(false)}
                  className="text-gray-500 hover:text-gray-700"
                >
                  <X size={24} />
                </button>
              </div>
              
              <div className="flex-1 overflow-auto p-6">
                <div className="grid grid-cols-2 gap-6">
                  {/* Painel Esquerdo: XML */}
                  <div>
                    <h3 className="font-semibold mb-2">XML de Origem</h3>
                    <textarea
                      value={curlXml}
                      readOnly
                      className="w-full h-96 p-4 border rounded font-mono text-sm bg-gray-50"
                    />
                  </div>
                  
                  {/* Painel Direito: Params & Body */}
                  <div className="space-y-6">
                    {/* Path Params */}
                    <div>
                      <h3 className="font-semibold mb-2">Path Parameters</h3>
                      {pathParams.length === 0 ? (
                        <p className="text-gray-500 text-sm">Nenhum path parameter</p>
                      ) : (
                        <div className="space-y-2">
                          {pathParams.map((p, i) => (
                            <div key={i} className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={p.active}
                                onChange={(e) => {
                                  const newParams = [...pathParams];
                                  newParams[i].active = e.target.checked;
                                  setPathParams(newParams);
                                }}
                                className="w-4 h-4"
                              />
                              <input
                                type="text"
                                value={p.key}
                                readOnly
                                className="px-2 py-1 border rounded bg-gray-50 w-32"
                              />
                              <input
                                type="text"
                                value={p.value}
                                onChange={(e) => {
                                  const newParams = [...pathParams];
                                  newParams[i].value = e.target.value;
                                  setPathParams(newParams);
                                }}
                                className="flex-1 px-2 py-1 border rounded"
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    
                    {/* Query Params */}
                    <div>
                      <h3 className="font-semibold mb-2">Query Parameters</h3>
                      {queryParams.length === 0 ? (
                        <p className="text-gray-500 text-sm">Nenhum query parameter</p>
                      ) : (
                        <div className="space-y-2 max-h-48 overflow-auto">
                          {queryParams.map((p, i) => (
                            <div key={i} className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={p.active}
                                onChange={(e) => {
                                  const newParams = [...queryParams];
                                  newParams[i].active = e.target.checked;
                                  setQueryParams(newParams);
                                }}
                                className="w-4 h-4"
                              />
                              <input
                                type="text"
                                value={p.key}
                                readOnly
                                className="px-2 py-1 border rounded bg-gray-50 w-32"
                              />
                              <input
                                type="text"
                                value={p.value}
                                onChange={(e) => {
                                  const newParams = [...queryParams];
                                  newParams[i].value = e.target.value;
                                  setQueryParams(newParams);
                                }}
                                className="flex-1 px-2 py-1 border rounded"
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    
                    {/* Headers */}
                    <div>
                      <h3 className="font-semibold mb-2">Headers Obrigatórios</h3>
                      {headers.length === 0 ? (
                        <p className="text-gray-500 text-sm">Nenhum header obrigatório definido na especificação.</p>
                      ) : (
                        <div className="space-y-3 max-h-64 overflow-auto">
                          {headers.map((h, i) => (
                            <div key={i} className="border-b pb-2">
                              <div className="flex items-center gap-2 mb-1">
                                <input
                                  type="text"
                                  value={h.key}
                                  readOnly
                                  className="px-2 py-1 border rounded bg-gray-50 w-48 font-mono text-sm"
                                />
                                <input
                                  type="text"
                                  value={h.value}
                                  onChange={(e) => {
                                    const newHeaders = [...headers];
                                    newHeaders[i].value = e.target.value;
                                    setHeaders(newHeaders);
                                  }}
                                  className="flex-1 px-2 py-1 border rounded font-mono text-sm"
                                />
                              </div>
                              {h.description && (
                                <p className="text-xs text-gray-600 ml-2">{h.description}</p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    
                    {/* Body JSON */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="font-semibold">Body JSON</h3>
                        <div className="flex items-center gap-4">
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={bodyOnlyWithValues}
                              onChange={(e) => setBodyOnlyWithValues(e.target.checked)}
                              className="w-4 h-4"
                            />
                            Campos com Valores
                          </label>
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={showBodyJson}
                              onChange={(e) => setShowBodyJson(e.target.checked)}
                              className="w-4 h-4"
                            />
                            {showBodyJson ? <Eye size={16} /> : <EyeOff size={16} />}
                          </label>
                        </div>
                      </div>
                      
                      {showBodyJson && (
                        <textarea
                          value={bodyJson}
                          onChange={(e) => setBodyJson(e.target.value)}
                          className="w-full h-64 p-4 border rounded font-mono text-sm"
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
              
              <div className="p-6 border-t flex justify-end gap-2">
                <button
                  onClick={() => setShowMappingModal(false)}
                  className="px-6 py-2 border rounded hover:bg-gray-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleGenerateCurl}
                  className="px-6 py-2 bg-purple-500 text-white rounded hover:bg-purple-600"
                >
                  Gerar cURL
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}