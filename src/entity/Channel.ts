/* eslint-disable import/no-cycle */
import { PrimaryColumn, Entity, ManyToOne, BaseEntity, Column } from 'typeorm';
import { Guild } from './Guild';

@Entity()
export class Channel extends BaseEntity {
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({
    default: false,
  })
  listen: boolean;

  @Column({
    default: false,
  })
  autoRespond: boolean;

  @ManyToOne(() => Guild, (guild) => guild.channels)
  guild: Guild;
}
