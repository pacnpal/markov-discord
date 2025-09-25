import {MigrationInterface, QueryRunner} from "typeorm";

export class AddPerformanceIndexes1704067200000 implements MigrationInterface {
    name = 'AddPerformanceIndexes1704067200000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Add index for Channel.guildId lookups - frequently used to filter channels by guild
        await queryRunner.query(`CREATE INDEX "IDX_channel_guild_id" ON "channel" ("guildId")`);
        
        // Add index for Channel.listen queries - used to find channels that should listen for messages
        await queryRunner.query(`CREATE INDEX "IDX_channel_listen" ON "channel" ("listen")`);
        
        // Add composite index for guild + listen queries - commonly used together
        await queryRunner.query(`CREATE INDEX "IDX_channel_guild_listen" ON "channel" ("guildId", "listen")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drop indexes in reverse order
        await queryRunner.query(`DROP INDEX "IDX_channel_guild_listen"`);
        await queryRunner.query(`DROP INDEX "IDX_channel_listen"`);
        await queryRunner.query(`DROP INDEX "IDX_channel_guild_id"`);
    }
}