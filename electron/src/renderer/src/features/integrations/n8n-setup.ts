import template from './n8n-workflow.json';
import { backendEndpoint } from './mcp-setup';

/** A manual workflow: exporting it never starts generation or enables networking. */
export function n8nSetup(slug: string, baseUrl: string) {
  if (slug !== 'n8n') return null;
  const url = backendEndpoint(baseUrl, '/v1/audio/speech');
  if (!url) return null;
  const workflow = {
    id: crypto.randomUUID().replaceAll('-', '').slice(0, 20),
    ...structuredClone(template),
  };
  const request = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.httpRequest')!;
  request.parameters.url = url;
  return {
    file: 'voicestudio-n8n.json',
    docs: 'https://github.com/evslanca/VoiceStudio/blob/main/docs/integrations/n8n.md',
    text: JSON.stringify(workflow, null, 2),
  };
}

export function n8nMusicSetup(slug: string, baseUrl: string) {
  if (slug !== 'n8n') return null;
  const url = backendEndpoint(baseUrl, '/api/music/generate');
  if (!url) return null;
  const workflow = {
    id: crypto.randomUUID().replaceAll('-', '').slice(0, 20),
    ...structuredClone(template),
    name: 'EliVoice Music Studio',
  };
  const request = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.httpRequest')!;
  request.parameters.url = url;
  request.parameters.jsonBody = JSON.stringify(
    {
      prompt: 'MPB acústico suave com violão',
      lyrics: '[verse]\nNovo som no EliVoice',
      vocal_language: 'pt',
      vocal_gender: 'auto',
      duration: 90,
    },
    null,
    2,
  );
  return {
    file: 'elivoice-music-n8n.json',
    docs: 'https://github.com/evslanca/VoiceStudio/blob/main/docs/integrations/n8n.md',
    text: JSON.stringify(workflow, null, 2),
  };
}
