import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScheduledMessageDispatcher } from './scheduled-message.dispatcher';
import { MessageService } from './message.service';
import { Message, MessageStatus } from './entities/message.entity';

function scheduledRow(id: string): Message {
  return {
    id,
    sessionId: 'sess-1',
    waMessageId: null as unknown as string,
    chatId: '628123456789@c.us',
    from: '628123456789',
    to: '628123456789@c.us',
    body: 'Reminder',
    type: 'text',
    direction: 'outgoing' as Message['direction'],
    timestamp: null as unknown as number,
    sendAt: new Date(Date.now() - 1000),
    metadata: null as unknown as Record<string, unknown>,
    status: MessageStatus.SCHEDULED,
    createdAt: new Date(),
  };
}

describe('ScheduledMessageDispatcher', () => {
  let dispatcher: ScheduledMessageDispatcher;
  let repository: jest.Mocked<Partial<Repository<Message>>>;
  let messageService: jest.Mocked<Partial<MessageService>>;

  beforeEach(async () => {
    jest.useFakeTimers();

    repository = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    messageService = {
      deliverMessage: jest.fn().mockResolvedValue({ messageId: 'wa-msg-1', timestamp: 1706868000 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledMessageDispatcher,
        { provide: getRepositoryToken(Message, 'data'), useValue: repository },
        { provide: MessageService, useValue: messageService },
      ],
    }).compile();

    dispatcher = module.get<ScheduledMessageDispatcher>(ScheduledMessageDispatcher);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('queries due rows ordered by sendAt with the scheduled status', async () => {
    await dispatcher.onModuleInit();

    const findMock = repository.find as unknown as jest.Mock<Promise<Message[]>, [Record<string, unknown>]>;
    const call = findMock.mock.calls[0][0];

    expect(call.where?.status).toBe(MessageStatus.SCHEDULED);
    expect(call.where?.sendAt).toBeDefined();
    expect(call.order).toEqual({ sendAt: 'ASC' });
    expect(call.take).toBe(50);

    dispatcher.onModuleDestroy();
  });

  it('does not deliver anything when there are no due rows', async () => {
    await dispatcher.onModuleInit();

    expect(messageService.deliverMessage).not.toHaveBeenCalled();

    dispatcher.onModuleDestroy();
  });

  it('claims and delivers each due message (after the boot stale-claim reset)', async () => {
    (repository.find as jest.Mock).mockResolvedValueOnce([scheduledRow('m1'), scheduledRow('m2')]);

    await dispatcher.onModuleInit();

    // Update #1 is the boot reset of stale claims; #2 and #3 claim each due row.
    expect(repository.update).toHaveBeenNthCalledWith(
      1,
      { status: MessageStatus.SENDING },
      { status: MessageStatus.SCHEDULED },
    );
    expect(repository.update).toHaveBeenNthCalledWith(
      2,
      { id: 'm1', status: MessageStatus.SCHEDULED },
      { status: MessageStatus.SENDING },
    );
    expect(repository.update).toHaveBeenNthCalledWith(
      3,
      { id: 'm2', status: MessageStatus.SCHEDULED },
      { status: MessageStatus.SENDING },
    );

    expect(messageService.deliverMessage).toHaveBeenCalledTimes(2);

    dispatcher.onModuleDestroy();
  });

  it('skips a message whose claim already moved off scheduled (another process won)', async () => {
    (repository.find as jest.Mock).mockResolvedValueOnce([scheduledRow('taken'), scheduledRow('mine')]);
    // Reset consumes the first update; then 'taken' loses the race, 'mine' wins.
    (repository.update as jest.Mock)
      .mockResolvedValueOnce({ affected: 1 })
      .mockResolvedValueOnce({ affected: 0 })
      .mockResolvedValueOnce({ affected: 1 });

    await dispatcher.onModuleInit();

    expect(messageService.deliverMessage).toHaveBeenCalledTimes(1);
    expect(messageService.deliverMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'mine' }));

    dispatcher.onModuleDestroy();
  });

  it('swallows a delivery failure without stopping the sweep', async () => {
    (repository.find as jest.Mock).mockResolvedValueOnce([scheduledRow('bad'), scheduledRow('good')]);
    (messageService.deliverMessage as jest.Mock).mockRejectedValueOnce(new Error('boom'));

    await dispatcher.onModuleInit();

    expect(messageService.deliverMessage).toHaveBeenCalledTimes(2);

    dispatcher.onModuleDestroy();
  });

  it('runs the sweep on every tick', async () => {
    await dispatcher.onModuleInit();
    (repository.find as jest.Mock).mockClear();

    jest.advanceTimersByTime(15_000);

    expect(repository.find).toHaveBeenCalledTimes(3); // init + 3 ticks

    dispatcher.onModuleDestroy();
  });

  it('resets stale sending claims to scheduled on boot', async () => {
    await dispatcher.onModuleInit();

    expect(repository.update).toHaveBeenCalledWith(
      { status: MessageStatus.SENDING },
      { status: MessageStatus.SCHEDULED },
    );

    dispatcher.onModuleDestroy();
  });

  it('stops sweeping after destroy', async () => {
    await dispatcher.onModuleInit();
    dispatcher.onModuleDestroy();

    (repository.find as jest.Mock).mockClear();
    jest.advanceTimersByTime(15_000);

    expect(repository.find).not.toHaveBeenCalled();
  });
});
