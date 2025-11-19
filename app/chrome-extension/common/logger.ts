const LOG_ENDPOINT = 'http://localhost:6277/logs/write';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const logMessage = async (level: LogLevel, message: string) => {
  try {
    await fetch(LOG_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        level,
        message,
      }),
    });
  } catch (error) {
    console.error('logMessage failed:', error);
  }
};
