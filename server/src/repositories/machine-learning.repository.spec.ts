import { readFile } from 'node:fs/promises';
import { defaults } from 'src/dtos/config.dto.js';
import { EnvData } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { envData, mockEnvData, newConfigRepositoryMock } from 'test/repositories/config.repository.mock.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: vi.fn(),
}));

const waitForAbort: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init!.signal!;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

describe(MachineLearningRepository.name, () => {
  const backgroundUrl = 'http://background:3003';
  const searchUrl = 'http://search:3003';
  const backupUrl = 'http://backup:3003';
  const model = { modelName: 'ViT-B-32__openai' };
  const fetchMock = vi.fn<typeof fetch>();
  let sut: MachineLearningRepository;

  const setup = (options: Partial<EnvData['machineLearning']> = {}, availabilityChecks = false) => {
    const configMock = newConfigRepositoryMock();
    configMock.getEnv.mockReturnValue(mockEnvData({ machineLearning: { ...envData.machineLearning, ...options } }));
    const logger = { setContext: vi.fn(), log: vi.fn(), warn: vi.fn() } as unknown as LoggingRepository;
    sut = new MachineLearningRepository(logger, configMock);
    sut.setup({
      ...defaults.machineLearning,
      urls: [backgroundUrl, backupUrl],
      availabilityChecks: { ...defaults.machineLearning.availabilityChecks, enabled: availabilityChecks },
    });
  };

  const requestedUrls = () => fetchMock.mock.calls.map(([url]) => url.toString());

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(readFile).mockResolvedValue(Buffer.from('image preview'));
  });

  afterEach(() => {
    sut?.teardown();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('should keep using the configured URL order when no search URLs are provided', async () => {
    setup();
    fetchMock.mockResolvedValue(Response.json({ clip: '[1,2,3]' }));

    await expect(sut.encodeText('a dog', model)).resolves.toBe('[1,2,3]');

    expect(requestedUrls()).toEqual([`${backgroundUrl}/predict`]);
    const formData = fetchMock.mock.calls[0][1]!.body as FormData;
    expect(formData.get('text')).toBe('a dog');
    expect(JSON.parse(formData.get('entries') as string)).toEqual({
      clip: { textual: { ...model, options: {} } },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should route text encoding to a dedicated search URL', async () => {
    setup({ searchUrls: [searchUrl] });
    fetchMock.mockResolvedValue(Response.json({ clip: '[1,2,3]' }));

    await sut.encodeText('a dog', model);

    expect(requestedUrls()).toEqual([`${searchUrl}/predict`]);
  });

  it.each(['image', 'faces', 'ocr'])('should keep %s jobs off the dedicated search URL', async (task) => {
    setup({ searchUrls: [searchUrl] });
    fetchMock.mockResolvedValue(
      Response.json({ clip: '[1,2,3]', 'facial-recognition': [], ocr: {}, imageWidth: 100, imageHeight: 100 }),
    );

    switch (task) {
      case 'image': {
        await sut.encodeImage('/preview.jpg', { ...defaults.machineLearning.clip });
        break;
      }
      case 'faces': {
        await sut.detectFaces('/preview.jpg', defaults.machineLearning.facialRecognition);
        break;
      }
      case 'ocr': {
        await sut.ocr('/preview.jpg', defaults.machineLearning.ocr);
        break;
      }
    }

    expect(requestedUrls()).toEqual([`${backgroundUrl}/predict`]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should fall back to a background URL after an unsuccessful search response', async () => {
    setup({ searchUrls: [searchUrl] });
    fetchMock
      .mockResolvedValueOnce(new Response('Unavailable', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ clip: '[1,2,3]' }));

    await expect(sut.encodeText('a dog', model)).resolves.toBe('[1,2,3]');

    expect(requestedUrls()).toEqual([`${searchUrl}/predict`, `${backgroundUrl}/predict`]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should fall back after a connection failure', async () => {
    setup({ searchUrls: [searchUrl] });
    fetchMock
      .mockRejectedValueOnce(new TypeError('Connection refused'))
      .mockResolvedValueOnce(Response.json({ clip: '[1,2,3]' }));

    await expect(sut.encodeText('a dog', model)).resolves.toBe('[1,2,3]');
    expect(requestedUrls()).toEqual([`${searchUrl}/predict`, `${backgroundUrl}/predict`]);
  });

  it('should fall back when a successful response contains invalid JSON', async () => {
    setup({ searchUrls: [searchUrl] });
    fetchMock
      .mockResolvedValueOnce(new Response('invalid JSON'))
      .mockResolvedValueOnce(Response.json({ clip: '[1,2,3]' }));

    await expect(sut.encodeText('a dog', model)).resolves.toBe('[1,2,3]');
    expect(requestedUrls()).toEqual([`${searchUrl}/predict`, `${backgroundUrl}/predict`]);
  });

  it('should abort a stalled search request and try the next URL', async () => {
    setup({ searchUrls: [searchUrl] });
    fetchMock.mockImplementationOnce(waitForAbort).mockResolvedValueOnce(Response.json({ clip: '[1,2,3]' }));

    const result = sut.encodeText('a dog', model);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(requestedUrls()).toEqual([`${searchUrl}/predict`]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe('[1,2,3]');
    expect(fetchMock.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(requestedUrls()).toEqual([`${searchUrl}/predict`, `${backgroundUrl}/predict`]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should keep the search deadline active while reading the response body', async () => {
    setup({ searchUrls: [searchUrl] });
    fetchMock
      .mockImplementationOnce((_input, init) => {
        const body = new ReadableStream({
          start(controller) {
            const signal = init!.signal!;
            signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
          },
        });
        return Promise.resolve(new Response(body));
      })
      .mockResolvedValueOnce(Response.json({ clip: '[1,2,3]' }));

    const result = sut.encodeText('a dog', model);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toBe('[1,2,3]');
    expect(requestedUrls()).toEqual([`${searchUrl}/predict`, `${backgroundUrl}/predict`]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should allow a longer deadline for background indexing', async () => {
    setup({ requestTimeout: 90_000, searchTimeout: 1000 });
    fetchMock.mockImplementationOnce(waitForAbort).mockResolvedValueOnce(Response.json({ clip: '[1,2,3]' }));

    const result = sut.encodeImage('/preview.jpg', defaults.machineLearning.clip);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(requestedUrls()).toEqual([`${backgroundUrl}/predict`]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe('[1,2,3]');
    expect(requestedUrls()).toEqual([`${backgroundUrl}/predict`, `${backupUrl}/predict`]);
  });

  it('should honor a custom search deadline', async () => {
    setup({ searchUrls: [searchUrl], searchTimeout: 1000 });
    fetchMock.mockImplementationOnce(waitForAbort).mockResolvedValueOnce(Response.json({ clip: '[1,2,3]' }));

    const result = sut.encodeText('a dog', model);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(result).resolves.toBe('[1,2,3]');
    expect(requestedUrls()).toEqual([`${searchUrl}/predict`, `${backgroundUrl}/predict`]);
  });

  it('should report failure after trying each distinct URL once and clear deadlines', async () => {
    setup({ searchUrls: [searchUrl, searchUrl, backgroundUrl] });
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(sut.encodeText('a dog', model)).rejects.toThrow('failed for all URLs');
    expect(requestedUrls()).toEqual([`${searchUrl}/predict`, `${backgroundUrl}/predict`, `${backupUrl}/predict`]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should include dedicated URLs in availability checks and prefer healthy servers', async () => {
    fetchMock.mockImplementation((input) => {
      const url = input.toString();
      if (url.endsWith('/ping')) {
        return Promise.resolve(new Response(null, { status: url.startsWith(searchUrl) ? 503 : 200 }));
      }
      return Promise.resolve(Response.json({ clip: '[1,2,3]' }));
    });
    setup({ searchUrls: [searchUrl, backgroundUrl] }, true);
    await vi.advanceTimersByTimeAsync(0);

    expect(requestedUrls()).toEqual([`${searchUrl}/ping`, `${backgroundUrl}/ping`, `${backupUrl}/ping`]);
    await sut.encodeText('a dog', model);

    expect(requestedUrls().at(-1)).toBe(`${backgroundUrl}/predict`);
    sut.teardown();
    expect(vi.getTimerCount()).toBe(0);
  });
});
