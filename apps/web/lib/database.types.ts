export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agents: {
        Row: {
          created_at: string
          device_secret_hash: string | null
          discovered_queues: Json
          enrollment_code: string | null
          enrollment_code_expires_at: string | null
          hostname: string | null
          id: string
          ip_addresses: string[] | null
          is_git_checkout: boolean | null
          last_seen_at: string | null
          name: string
          organization_id: string
          os_version: string | null
          paused: boolean
          paused_at: string | null
          paused_by: string | null
          status: string
          version: string | null
        }
        Insert: {
          created_at?: string
          device_secret_hash?: string | null
          discovered_queues?: Json
          enrollment_code?: string | null
          enrollment_code_expires_at?: string | null
          hostname?: string | null
          id?: string
          ip_addresses?: string[] | null
          is_git_checkout?: boolean | null
          last_seen_at?: string | null
          name: string
          organization_id: string
          os_version?: string | null
          paused?: boolean
          paused_at?: string | null
          paused_by?: string | null
          status?: string
          version?: string | null
        }
        Update: {
          created_at?: string
          device_secret_hash?: string | null
          discovered_queues?: Json
          enrollment_code?: string | null
          enrollment_code_expires_at?: string | null
          hostname?: string | null
          id?: string
          ip_addresses?: string[] | null
          is_git_checkout?: boolean | null
          last_seen_at?: string | null
          name?: string
          organization_id?: string
          os_version?: string | null
          paused?: boolean
          paused_at?: string | null
          paused_by?: string | null
          status?: string
          version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agents_paused_by_fkey"
            columns: ["paused_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_actions: {
        Row: {
          approver_id: string
          created_at: string
          decision: string
          id: string
          job_id: string
          reason: string | null
        }
        Insert: {
          approver_id: string
          created_at?: string
          decision: string
          id?: string
          job_id: string
          reason?: string | null
        }
        Update: {
          approver_id?: string
          created_at?: string
          decision?: string
          id?: string
          job_id?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "approval_actions_approver_id_fkey"
            columns: ["approver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_actions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "print_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          id: string
          metadata: Json
          organization_id: string | null
          target_id: string | null
          target_type: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          organization_id?: string | null
          target_id?: string | null
          target_type?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          organization_id?: string | null
          target_id?: string | null
          target_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      device_events: {
        Row: {
          created_at: string
          detail: Json
          device_id: string
          id: string
          type: string
          user_agent: string | null
        }
        Insert: {
          created_at?: string
          detail?: Json
          device_id: string
          id?: string
          type: string
          user_agent?: string | null
        }
        Update: {
          created_at?: string
          detail?: Json
          device_id?: string
          id?: string
          type?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "device_events_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "member_devices"
            referencedColumns: ["id"]
          },
        ]
      }
      device_issues: {
        Row: {
          created_at: string
          device_id: string
          id: string
          kind: string
          note: string
          resolved_at: string | null
          resolved_by: string | null
          resolved_note: string | null
          status: string
        }
        Insert: {
          created_at?: string
          device_id: string
          id?: string
          kind: string
          note?: string
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_note?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          device_id?: string
          id?: string
          kind?: string
          note?: string
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_note?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_issues_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "member_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_issues_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      device_setup_feedback: {
        Row: {
          created_at: string
          device_id: string
          id: string
          note: string
          organization_id: string
          outcome: string
          setup_key: string
          setup_variant: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          device_id: string
          id?: string
          note?: string
          organization_id?: string
          outcome: string
          setup_key?: string
          setup_variant?: string | null
          user_id?: string
        }
        Update: {
          created_at?: string
          device_id?: string
          id?: string
          note?: string
          organization_id?: string
          outcome?: string
          setup_key?: string
          setup_variant?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_setup_feedback_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: true
            referencedRelation: "member_devices"
            referencedColumns: ["id"]
          },
        ]
      }
      setup_confirmations: {
        Row: {
          confirmed_at: string
          confirmed_by: string
          organization_id: string
          setup_key: string
        }
        Insert: {
          confirmed_at?: string
          confirmed_by: string
          organization_id: string
          setup_key: string
        }
        Update: {
          confirmed_at?: string
          confirmed_by?: string
          organization_id?: string
          setup_key?: string
        }
        Relationships: []
      }
      group_members: {
        Row: {
          created_at: string
          group_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          group_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          group_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      groups: {
        Row: {
          created_at: string
          id: string
          kind: string
          name: string
          organization_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind?: string
          name: string
          organization_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          name?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      member_devices: {
        Row: {
          created_at: string
          device_type: string
          first_job_at: string | null
          first_printed_at: string | null
          first_seen_at: string | null
          id: string
          last_seen_at: string | null
          last_user_agent: string | null
          name: string
          organization_id: string
          revoked_at: string | null
          token_hash: string
          user_id: string
        }
        Insert: {
          created_at?: string
          device_type?: string
          first_job_at?: string | null
          first_printed_at?: string | null
          first_seen_at?: string | null
          id?: string
          last_seen_at?: string | null
          last_user_agent?: string | null
          name: string
          organization_id: string
          revoked_at?: string | null
          token_hash: string
          user_id: string
        }
        Update: {
          created_at?: string
          device_type?: string
          first_job_at?: string | null
          first_printed_at?: string | null
          first_seen_at?: string | null
          id?: string
          last_seen_at?: string | null
          last_user_agent?: string | null
          name?: string
          organization_id?: string
          revoked_at?: string | null
          token_hash?: string
          user_id?: string
        }
        Relationships: []
      }
      monthly_usage: {
        Row: {
          color_weighted_used: number
          id: string
          organization_id: string
          pdf_pages_used: number
          period: string
          physical_sheets_used: number
          printed_sides_used: number
          reserved_color_weighted: number
          reserved_pdf_pages: number
          reserved_physical_sheets: number
          reserved_printed_sides: number
          updated_at: string
          user_id: string
        }
        Insert: {
          color_weighted_used?: number
          id?: string
          organization_id: string
          pdf_pages_used?: number
          period: string
          physical_sheets_used?: number
          printed_sides_used?: number
          reserved_color_weighted?: number
          reserved_pdf_pages?: number
          reserved_physical_sheets?: number
          reserved_printed_sides?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          color_weighted_used?: number
          id?: string
          organization_id?: string
          pdf_pages_used?: number
          period?: string
          physical_sheets_used?: number
          printed_sides_used?: number
          reserved_color_weighted?: number
          reserved_pdf_pages?: number
          reserved_physical_sheets?: number
          reserved_printed_sides?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "monthly_usage_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_usage_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_invitations: {
        Row: {
          code: string | null
          created_at: string
          created_by: string
          email: string | null
          expires_at: string | null
          group_id: string | null
          id: string
          max_uses: number | null
          organization_id: string
          role: string
          uses_count: number
        }
        Insert: {
          code?: string | null
          created_at?: string
          created_by: string
          email?: string | null
          expires_at?: string | null
          group_id?: string | null
          id?: string
          max_uses?: number | null
          organization_id: string
          role?: string
          uses_count?: number
        }
        Update: {
          code?: string | null
          created_at?: string
          created_by?: string
          email?: string | null
          expires_at?: string | null
          group_id?: string | null
          id?: string
          max_uses?: number | null
          organization_id?: string
          role?: string
          uses_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "organization_invitations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_invitations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_members: {
        Row: {
          created_at: string
          department: string | null
          organization_id: string
          role: string
          status: string
          user_code: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          department?: string | null
          organization_id: string
          role?: string
          status?: string
          user_code?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          department?: string | null
          organization_id?: string
          role?: string
          status?: string
          user_code?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_settings: {
        Row: {
          admins_bypass_restrictions: boolean
          auto_retry_failed_prints: boolean
          default_booklet_binding_side: string
          default_policy_action: string
          job_approval_expiry_hours: number
          job_lease_minutes: number
          max_upload_size_bytes: number
          organization_id: string
          quota_basis: string
          retention_completed_days: number
          retention_failed_days: number
          retention_pending_days: number | null
          retention_rejected_days: number
          stamp_enabled: boolean
          stamp_show: string
          stamp_strength: string
          updated_at: string
        }
        Insert: {
          admins_bypass_restrictions?: boolean
          auto_retry_failed_prints?: boolean
          default_booklet_binding_side?: string
          default_policy_action?: string
          job_approval_expiry_hours?: number
          job_lease_minutes?: number
          max_upload_size_bytes?: number
          organization_id: string
          quota_basis?: string
          retention_completed_days?: number
          retention_failed_days?: number
          retention_pending_days?: number | null
          retention_rejected_days?: number
          stamp_enabled?: boolean
          stamp_show?: string
          stamp_strength?: string
          updated_at?: string
        }
        Update: {
          admins_bypass_restrictions?: boolean
          auto_retry_failed_prints?: boolean
          default_booklet_binding_side?: string
          default_policy_action?: string
          job_approval_expiry_hours?: number
          job_lease_minutes?: number
          max_upload_size_bytes?: number
          organization_id?: string
          quota_basis?: string
          retention_completed_days?: number
          retention_failed_days?: number
          retention_pending_days?: number | null
          retention_rejected_days?: number
          stamp_enabled?: boolean
          stamp_show?: string
          stamp_strength?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          allowed_domains: string[]
          created_at: string
          id: string
          magic_link_requires_allowed_domain: boolean
          join_mode: string
          domain_join_role: string
          name: string
          slug: string
        }
        Insert: {
          allowed_domains?: string[]
          created_at?: string
          id?: string
          magic_link_requires_allowed_domain?: boolean
          join_mode?: string
          domain_join_role?: string
          name: string
          slug: string
        }
        Update: {
          allowed_domains?: string[]
          created_at?: string
          id?: string
          magic_link_requires_allowed_domain?: boolean
          join_mode?: string
          domain_join_role?: string
          name?: string
          slug?: string
        }
        Relationships: []
      }
      policy_rules: {
        Row: {
          action: string
          conditions: Json
          created_at: string
          enabled: boolean
          id: string
          policy_id: string
          priority: number
          reason_label: string
        }
        Insert: {
          action: string
          conditions?: Json
          created_at?: string
          enabled?: boolean
          id?: string
          policy_id: string
          priority?: number
          reason_label: string
        }
        Update: {
          action?: string
          conditions?: Json
          created_at?: string
          enabled?: boolean
          id?: string
          policy_id?: string
          priority?: number
          reason_label?: string
        }
        Relationships: [
          {
            foreignKeyName: "policy_rules_policy_id_fkey"
            columns: ["policy_id"]
            isOneToOne: false
            referencedRelation: "print_policies"
            referencedColumns: ["id"]
          },
        ]
      }
      print_job_events: {
        Row: {
          actor_id: string | null
          actor_type: string
          created_at: string
          event_type: string
          id: string
          job_id: string
          metadata: Json
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          created_at?: string
          event_type: string
          id?: string
          job_id: string
          metadata?: Json
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          created_at?: string
          event_type?: string
          id?: string
          job_id?: string
          metadata?: Json
        }
        Relationships: [
          {
            foreignKeyName: "print_job_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "print_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      print_jobs: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          attempt_count: number
          booklet_binding_side: string | null
          booklet_padding_added: number
          color_mode: string
          completed_at: string | null
          copies: number
          created_at: string
          created_by: string
          derived_file_path: string | null
          device_id: string | null
          duplex: boolean
          error_message: string | null
          estimated_cost_cents: number | null
          estimated_physical_sheets: number
          estimated_printed_sides: number
          expires_at: string | null
          file_size_bytes: number
          files_purged_at: string | null
          finishing: Json
          held_reason: string | null
          id: string
          ipp_user_agent: string | null
          is_test_print: boolean
          job_number: string
          lease_expires_at: string | null
          lease_owner_agent_id: string | null
          max_attempts: number
          organization_id: string
          original_file_name: string
          original_file_path: string
          page_range: string | null
          paper_size: string
          policy_action: string | null
          policy_bypassed_for_admin: boolean
          policy_reasons: string[]
          printer_id: string | null
          printer_profile_id: string | null
          source: string
          source_pdf_pages: number
          staple_position: string | null
          status: string
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          attempt_count?: number
          booklet_binding_side?: string | null
          booklet_padding_added?: number
          color_mode?: string
          completed_at?: string | null
          copies?: number
          created_at?: string
          created_by: string
          derived_file_path?: string | null
          device_id?: string | null
          duplex?: boolean
          error_message?: string | null
          estimated_cost_cents?: number | null
          estimated_physical_sheets: number
          estimated_printed_sides: number
          expires_at?: string | null
          file_size_bytes: number
          files_purged_at?: string | null
          finishing?: Json
          held_reason?: string | null
          id?: string
          ipp_user_agent?: string | null
          is_test_print?: boolean
          job_number?: string
          lease_expires_at?: string | null
          lease_owner_agent_id?: string | null
          max_attempts?: number
          organization_id: string
          original_file_name: string
          original_file_path: string
          page_range?: string | null
          paper_size?: string
          policy_action?: string | null
          policy_bypassed_for_admin?: boolean
          policy_reasons?: string[]
          printer_id?: string | null
          printer_profile_id?: string | null
          source?: string
          source_pdf_pages: number
          staple_position?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          attempt_count?: number
          booklet_binding_side?: string | null
          booklet_padding_added?: number
          color_mode?: string
          completed_at?: string | null
          copies?: number
          created_at?: string
          created_by?: string
          derived_file_path?: string | null
          device_id?: string | null
          duplex?: boolean
          error_message?: string | null
          estimated_cost_cents?: number | null
          estimated_physical_sheets?: number
          estimated_printed_sides?: number
          expires_at?: string | null
          file_size_bytes?: number
          files_purged_at?: string | null
          finishing?: Json
          held_reason?: string | null
          id?: string
          ipp_user_agent?: string | null
          is_test_print?: boolean
          job_number?: string
          lease_expires_at?: string | null
          lease_owner_agent_id?: string | null
          max_attempts?: number
          organization_id?: string
          original_file_name?: string
          original_file_path?: string
          page_range?: string | null
          paper_size?: string
          policy_action?: string | null
          policy_bypassed_for_admin?: boolean
          policy_reasons?: string[]
          printer_id?: string | null
          printer_profile_id?: string | null
          source?: string
          source_pdf_pages?: number
          staple_position?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "print_jobs_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "print_jobs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "print_jobs_lease_owner_agent_id_fkey"
            columns: ["lease_owner_agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "print_jobs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "print_jobs_printer_id_fkey"
            columns: ["printer_id"]
            isOneToOne: false
            referencedRelation: "printers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "print_jobs_printer_profile_id_fkey"
            columns: ["printer_profile_id"]
            isOneToOne: false
            referencedRelation: "printer_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      print_policies: {
        Row: {
          applies_to_role: string[] | null
          created_at: string
          enabled: boolean
          id: string
          name: string
          organization_id: string
        }
        Insert: {
          applies_to_role?: string[] | null
          created_at?: string
          enabled?: boolean
          id?: string
          name: string
          organization_id: string
        }
        Update: {
          applies_to_role?: string[] | null
          created_at?: string
          enabled?: boolean
          id?: string
          name?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "print_policies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      printer_profiles: {
        Row: {
          agent_id: string
          booklet_binding_side: string
          created_at: string
          declared_capabilities: Json
          declared_paper_sizes: string[]
          description: string | null
          icon_key: string | null
          id: string
          is_default: boolean
          key: string
          label: string
          pricing: Json | null
          printer_id: string
          windows_queue_name: string | null
          output_mode: string
          raw_host: string | null
          raw_port: number
          raw_staple_position: string
        }
        Insert: {
          agent_id: string
          booklet_binding_side?: string
          created_at?: string
          declared_capabilities?: Json
          declared_paper_sizes?: string[]
          description?: string | null
          icon_key?: string | null
          id?: string
          is_default?: boolean
          key: string
          label: string
          pricing?: Json | null
          printer_id: string
          windows_queue_name?: string | null
          output_mode?: string
          raw_host?: string | null
          raw_port?: number
          raw_staple_position?: string
        }
        Update: {
          agent_id?: string
          booklet_binding_side?: string
          created_at?: string
          declared_capabilities?: Json
          declared_paper_sizes?: string[]
          description?: string | null
          icon_key?: string | null
          id?: string
          is_default?: boolean
          key?: string
          label?: string
          pricing?: Json | null
          printer_id?: string
          windows_queue_name?: string | null
          output_mode?: string
          raw_host?: string | null
          raw_port?: number
          raw_staple_position?: string
        }
        Relationships: [
          {
            foreignKeyName: "printer_profiles_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "printer_profiles_printer_id_fkey"
            columns: ["printer_id"]
            isOneToOne: false
            referencedRelation: "printers"
            referencedColumns: ["id"]
          },
        ]
      }
      printers: {
        Row: {
          created_at: string
          id: string
          last_status_at: string | null
          location: string | null
          model: string | null
          name: string
          organization_id: string
          snmp_config: Json
          status: string
          vendor: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          last_status_at?: string | null
          location?: string | null
          model?: string | null
          name: string
          organization_id: string
          snmp_config?: Json
          status?: string
          vendor?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          last_status_at?: string | null
          location?: string | null
          model?: string | null
          name?: string
          organization_id?: string
          snmp_config?: Json
          status?: string
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "printers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          email: string
          id: string
          last_authenticated_at: string | null
          platform_role: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email: string
          id: string
          last_authenticated_at?: string | null
          platform_role?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string
          id?: string
          last_authenticated_at?: string | null
          platform_role?: string
        }
        Relationships: []
      }
      quotas: {
        Row: {
          created_at: string
          id: string
          limit_value: number
          organization_id: string
          period: string
          scope_type: string
          scope_value: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          limit_value: number
          organization_id: string
          period?: string
          scope_type: string
          scope_value?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          limit_value?: number
          organization_id?: string
          period?: string
          scope_type?: string
          scope_value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quotas_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      remote_commands: {
        Row: {
          agent_id: string
          command: string
          completed_at: string | null
          created_at: string
          id: string
          issued_by: string
          organization_id: string
          payload: Json
          printer_id: string | null
          result: Json | null
          status: string
        }
        Insert: {
          agent_id: string
          command: string
          completed_at?: string | null
          created_at?: string
          id?: string
          issued_by: string
          organization_id: string
          payload?: Json
          printer_id?: string | null
          result?: Json | null
          status?: string
        }
        Update: {
          agent_id?: string
          command?: string
          completed_at?: string | null
          created_at?: string
          id?: string
          issued_by?: string
          organization_id?: string
          payload?: Json
          printer_id?: string | null
          result?: Json | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "remote_commands_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "remote_commands_issued_by_fkey"
            columns: ["issued_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "remote_commands_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "remote_commands_printer_id_fkey"
            columns: ["printer_id"]
            isOneToOne: false
            referencedRelation: "printers"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      adjust_monthly_usage: {
        Args: {
          p_color_weighted: number
          // p_limit is `int` in supabase/migrations/0010_quota_functions.sql,
          // nullable at the SQL call site (null = no quota configured for
          // this scope, see that function's own inline comment) - the
          // generator doesn't always infer this nullability from a plain
          // function signature, so it's restored by hand after each
          // regeneration to match lib/quota.ts's actual `number | null` call.
          p_limit: number | null
          p_mode: string
          p_organization_id: string
          p_pdf_pages: number
          p_period: string
          p_physical_sheets: number
          p_printed_sides: number
          p_quota_basis: string
          p_user_id: string
        }
        Returns: boolean
      }
      check_rate_limit: {
        Args: { p_key: string; p_max_count: number; p_window_seconds: number }
        Returns: boolean
      }
      join_org_by_domain: {
        Args: { p_user_id: string }
        Returns: string | null
      }
      claim_invitation_use: {
        Args: { p_invitation_id: string }
        Returns: boolean
      }
      email_domain_allowed: { Args: never; Returns: boolean }
      email_domain_allowed_for_magic_link: { Args: never; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
