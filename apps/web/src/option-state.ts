import type { OptionDefinition, OptionDefinitionsResponse } from './types';

export type OptionDictionaryStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export interface OptionDictionaryState {
  status: OptionDictionaryStatus;
  definitions: OptionDefinition[];
  version: string | null;
  error: string | null;
}

export interface OptionDictionaryApi {
  getOptions(signal?: AbortSignal): Promise<OptionDefinitionsResponse>;
}

export class OptionDictionaryStore {
  private state: OptionDictionaryState = { status: 'idle', definitions: [], version: null, error: null };

  constructor(private readonly api: OptionDictionaryApi) {}

  getState(): OptionDictionaryState {
    return this.state;
  }

  async load(signal?: AbortSignal): Promise<void> {
    this.state = { ...this.state, status: 'loading', error: null };
    try {
      const response = await this.api.getOptions(signal);
      this.state = {
        status: response.options.length === 0 ? 'empty' : 'ready',
        definitions: response.options,
        version: response.version,
        error: null,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.state = { ...this.state, status: 'error', error: error instanceof Error ? error.message : '词条字典加载失败' };
    }
  }

  async retry(signal?: AbortSignal): Promise<void> {
    await this.load(signal);
  }
}
