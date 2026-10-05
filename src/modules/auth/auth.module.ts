import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { ApiKey } from './entities/api-key.entity';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthValidateController } from './auth-validate.controller';
import { ApiKeyGuard } from './guards/api-key.guard';
import { PerApiKeyThrottlerGuard } from './guards/per-api-key-throttler.guard';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ApiKey], 'main')],
  controllers: [AuthController, AuthValidateController],
  providers: [
    AuthService,
    {
      provide: APP_GUARD,
      // Ahead of ApiKeyGuard on purpose: it buckets on the presented key, which ApiKeyGuard
      // has not validated yet at this point. Ordering it after would leave every request
      // without a key on the fallback path.
      useClass: PerApiKeyThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
