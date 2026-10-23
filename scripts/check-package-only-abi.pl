#!/usr/bin/env perl
# SPDX-License-Identifier: Apache-2.0
# Run with -I <SDK>/scripts to use that SDK's own metadata parser.
use strict;
use warnings;
use utf8;

binmode STDOUT, ':encoding(UTF-8)';
binmode STDERR, ':encoding(UTF-8)';

sub fallback {
    my ($reason) = @_;
    print STDERR "回退完整依赖构建：$reason\n";
    exit 1;
}

@ARGV == 2 or fallback('用法：check-package-only-abi.pl <tmp/.packageinfo> <应用 Makefile>');
my ($info, $makefile) = @ARGV;
-f $info && -r $info or fallback('无法读取 SDK 软件包元数据');
open my $source, '<:encoding(UTF-8)', $makefile
    or fallback('无法读取应用 Makefile');
my @source_lines = <$source>;
close $source or fallback('读取应用 Makefile 失败');

# EXTRA_DEPENDS is not present in SDK dumpinfo. Never infer that it is empty.
grep(/EXTRA_DEPENDS/, @source_lines)
    and fallback('应用 Makefile 包含 EXTRA_DEPENDS，无法仅凭 SDK 元数据确认依赖');

# Require one unconditional, explicitly empty definition of each build hook.
# Reject later assignments and references that could replace those definitions.
my (%hooks, $hook);
my ($defines, $conditions) = (0, 0);
for my $line (@source_lines) {
    $line =~ s/\r?\n\z//;
    next if $line =~ /^\s*(?:#.*)?$/;

    if (defined $hook) {
        if ($line =~ /^\s*endef\s*(?:#.*)?$/) {
            undef $hook;
            next;
        }
        fallback("Build/$hook 不是空钩子");
    }

    if ($line =~ /^\s*define\s+Build\/(Configure|Compile)\s*(?:#.*)?$/) {
        my $name = $1;
        fallback("Build/$name 必须是无条件的顶层定义") if $defines || $conditions;
        fallback("Build/$name 存在重复定义") if $hooks{$name}++;
        $hook = $name;
        next;
    }

    fallback('发现其他 Build/Configure 或 Build/Compile 定义或引用')
        if $line =~ /\bBuild\/(?:Configure|Compile)\b/;

    if ($line =~ /^\s*(?:override\s+)?define(?:\s|$)/) {
        $defines++;
    } elsif ($line =~ /^\s*endef\s*(?:#.*)?$/) {
        $defines--;
        fallback('Makefile 的 define/endef 结构不完整') if $defines < 0;
    } elsif (!$defines && $line =~ /^\s*(?:ifdef|ifndef|ifeq|ifneq)(?:\s|\()/) {
        $conditions++;
    } elsif (!$defines && $line =~ /^\s*endif\s*(?:#.*)?$/) {
        $conditions--;
        fallback('Makefile 的条件结构不完整') if $conditions < 0;
    }
}
fallback('Makefile 的构建钩子或条件结构不完整')
    if defined $hook || $defines || $conditions;
for my $name (qw(Configure Compile)) {
    fallback("必须显式定义空的 Build/$name") unless $hooks{$name};
}

my @parse_warnings;
my $parsed = eval {
    local $SIG{__WARN__} = sub { push @parse_warnings, @_ };
    require metadata;
    metadata::parse_package_metadata($info);
};
fallback('SDK 元数据解析失败或格式不受支持')
    if !$parsed || $@ || @parse_warnings;

my ($packages, $providers);
{
    no warnings 'once';
    $packages = \%metadata::package;
    $providers = \%metadata::vpackage;
}

# Positive evidence that this SDK parser exposes ABI versions. Unknown or
# incomplete SDK formats must not silently enable the package-only path.
my $has_abi = grep {
    defined $_->{abi_version} && length $_->{abi_version}
} values %$packages;
fallback('SDK 元数据中没有可确认的 ABI-Version 字段') unless $has_abi;

my $app = $packages->{'luci-app-easy-discovery'};
fallback('缺少应用的直接依赖元数据')
    unless $app && ref($app->{depends}) eq 'ARRAY' && @{$app->{depends}};
fallback('缺少应用的源码元数据') unless ref($app->{src}) eq 'HASH';

for my $key (sort keys %{$app->{src}}) {
    next unless $key =~ /^builddepends(?:\/.*)?$/;
    my $depends = $app->{src}{$key};
    fallback("应用存在 $key 构建依赖")
        unless ref($depends) eq 'ARRAY' && !@$depends;
}

my %seen;
for my $raw (@{$app->{depends}}) {
    my $dep = $raw;
    $dep =~ s/^\+//;
    fallback("无法安全判断复杂依赖：$raw")
        unless $dep =~ /\A[A-Za-z0-9][A-Za-z0-9_.+-]*\z/;
    next if $seen{$dep}++;

    my $candidates = $providers->{$dep};
    fallback("找不到依赖提供者：$dep")
        unless ref($candidates) eq 'ARRAY' && @$candidates;
    for my $provider (@$candidates) {
        my $abi = $provider->{abi_version};
        # The string "0" is a valid, nonempty ABI version too.
        if (defined $abi && length $abi) {
            fallback("依赖 $dep 的提供者 $provider->{name} 声明 ABI $abi");
        }
    }
}

print '允许仅构建应用：空编译钩子、无构建依赖，', scalar(keys %seen),
    " 个直接依赖的全部提供者均无 ABI 后缀。\n";
exit 0;
