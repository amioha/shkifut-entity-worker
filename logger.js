import winston from 'winston';
export default winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, docId }) =>
      `${timestamp} ${level}${docId?` [doc:${docId}]`:''} ${message}`
    )
  ),
  transports: [new winston.transports.Console()],
});
